import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { hashPassword, verifyPassword } from '../core/auth';
import { nanoId } from '../kernel';
import {
    type IPluginEngine,
    type HookContext,
    type SiteRole,
    type AuthenticatedUser
} from '../types';
import {
    buildCreateUserStatement,
    buildAddSiteMemberStatement,
    buildUpdateUserStatement,
    buildUpdateUserPasswordStatement,
    findUserById,
    findUserMetadataById,
    buildUpdateUserMetadataStatement,
    buildUpsertSiteMemberRoleStatement,
    buildDeleteSiteMemberStatement,
    buildDeleteUserStatement,
    buildIncrementUserTokenVersionStatement,
    buildDeleteUserMetadataStatement,
    hasOtherSiteMemberships,
    buildRevokeApiTokensByCreatorStatement,
    findUserForAuth,
    findSiteMemberRole
} from '../core/dal';
import { assertSiteAdmin } from './common.helper';

export interface CreateUserActionParams {
    siteId: string;
    username: string;
    email: string;
    passwordPlain: string;
    role: SiteRole;
    globalRole?: 'user' | 'superadmin';
}

export interface EditUserActionParams {
    userId: string;
    username: string;
    email: string;
    globalRole: string;
    siteId: string;
    role: SiteRole;
    newPassword?: string;
}

export interface LoginContextResult {
    success: boolean;
    user?: AuthenticatedUser;
    error?: string;
}

async function buildUserRemovalStatements(
    db: D1Database,
    userId: string,
    siteId: string,
    isSuperAdmin: boolean
): Promise<D1PreparedStatement[]> {
    const sharedElsewhere = !isSuperAdmin && await hasOtherSiteMemberships(db, userId, siteId);
    if (sharedElsewhere) {
        // Only sever membership and tokens for the current site so shared users on other sites are preserved.
        return [
            buildDeleteSiteMemberStatement(db, userId, siteId),
            buildIncrementUserTokenVersionStatement(db, userId),
            buildRevokeApiTokensByCreatorStatement(db, userId, siteId)
        ];
    }
    return [
        buildDeleteSiteMemberStatement(db, userId),
        buildDeleteUserMetadataStatement(db, userId),
        buildRevokeApiTokensByCreatorStatement(db, userId),
        buildDeleteUserStatement(db, userId)
    ];
}

export function registerUsersAuthServices(engine: IPluginEngine): void {
    engine.registerService<CreateUserActionParams, { success: boolean; userId: string }>(
        'USER_CREATE',
        async (ctx) => {
            const params = ctx.data;
            await assertSiteAdmin(ctx.dal, params.siteId || ctx.siteId || 'site_default', ctx.user);
            if (params.globalRole === 'superadmin' && ctx.user?.global_role !== 'superadmin') {
                throw new Error('FORBIDDEN_PRIVILEGE_ESCALATION');
            }
            const userId = nanoId('u');
            const memberId = nanoId('sm');
            const passwordHash = await hashPassword(params.passwordPlain);
            const globalRole = params.globalRole || 'user';

            await ctx.dal.batch([
                buildCreateUserStatement(ctx.dal.db, {
                    id: userId,
                    email: params.email.trim(),
                    username: params.username.trim(),
                    passwordHash,
                    globalRole
                }),
                buildAddSiteMemberStatement(ctx.dal.db, {
                    id: memberId,
                    siteId: params.siteId,
                    userId,
                    role: params.role || 'visitor'
                })
            ]);

            return { success: true, userId };
        }
    );

    engine.tapBefore<EditUserActionParams>('USER_UPDATE', async (ctx) => {
        const targetSiteId = ctx.data?.siteId || ctx.siteId || 'site_default';
        await assertSiteAdmin(ctx.dal, targetSiteId, ctx.user);
        if (ctx.user?.global_role !== 'superadmin') {
            if (ctx.data?.globalRole === 'superadmin') {
                throw new Error('FORBIDDEN_PRIVILEGE_ESCALATION');
            }
            const targetUser = await findUserById(ctx.dal.db, ctx.data?.userId);
            if (targetUser?.global_role === 'superadmin') {
                throw new Error('FORBIDDEN_PRIVILEGE_ESCALATION');
            }
            const memberRole = await findSiteMemberRole(ctx.dal.db, targetSiteId, ctx.data?.userId);
            if (!memberRole) {
                throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
            }
        }
    });

    engine.registerService<EditUserActionParams, { success: boolean }>('USER_UPDATE', async (ctx) => {
        const params = ctx.data;
        const nowIso = new Date().toISOString();
        const batchList: D1PreparedStatement[] = [];
        const [prevUser, prevMemberRole] = await Promise.all([
            findUserById(ctx.dal.db, params.userId),
            findSiteMemberRole(ctx.dal.db, params.siteId, params.userId)
        ]);

        const passwordHash = params.newPassword && params.newPassword.length >= 6
            ? await hashPassword(params.newPassword)
            : null;
        batchList.push(
            buildUpdateUserStatement(
                ctx.dal.db,
                params.userId,
                params.username,
                params.email,
                params.globalRole,
                passwordHash,
                nowIso
            )
        );
        batchList.push(
            buildUpsertSiteMemberRoleStatement(
                ctx.dal.db,
                nanoId('sm'),
                params.siteId,
                params.userId,
                params.role
            )
        );

        const globalDowngraded = prevUser?.global_role === 'superadmin' && params.globalRole !== 'superadmin';
        const siteDowngraded = prevMemberRole === 'admin' && params.role !== 'admin';
        if (passwordHash || globalDowngraded || siteDowngraded) {
            batchList.push(buildIncrementUserTokenVersionStatement(ctx.dal.db, params.userId));
        }
        if (globalDowngraded || siteDowngraded) {
            batchList.push(buildRevokeApiTokensByCreatorStatement(ctx.dal.db, params.userId, globalDowngraded ? undefined : params.siteId));
        }

        await ctx.dal.batch(batchList);
        return { success: true };
    });

    engine.registerService<{ id: string }, { success: boolean }>('USER_DELETE', async (ctx) => {
        const siteId = ctx.siteId || 'site_default';
        await assertSiteAdmin(ctx.dal, siteId, ctx.user);
        const userId = ctx.data.id;
        const isSuper = ctx.user?.global_role === 'superadmin';
        if (!isSuper) {
            const role = await findSiteMemberRole(ctx.dal.db, siteId, userId);
            if (!role) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
        }
        await ctx.dal.batch(await buildUserRemovalStatements(ctx.dal.db, userId, siteId, isSuper));
        return { success: true };
    });

    engine.registerService<{ userIds: string[] }, { count: number; success: boolean }>(
        'USER_BATCH_DELETE',
        async (ctx) => {
            const siteId = ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, siteId, ctx.user);
            const userIds = ctx.data.userIds || [];
            if (userIds.length > 15) throw new Error('BATCH_LIMIT_EXCEEDED');
            const isSuper = ctx.user?.global_role === 'superadmin';
            const statements: D1PreparedStatement[] = [];
            for (const uid of userIds) {
                if (!isSuper) {
                    const role = await findSiteMemberRole(ctx.dal.db, siteId, uid);
                    if (!role) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                }
                statements.push(...await buildUserRemovalStatements(ctx.dal.db, uid, siteId, isSuper));
            }
            if (statements.length > 0) {
                await ctx.dal.batch(statements);
            }
            return { count: userIds.length, success: true };
        }
    );

    const assertSelfOrSuperAdmin = (ctx: HookContext<{ userId?: string }>) => {
        if (!ctx.user) throw new Error('UNAUTHENTICATED');
        if (ctx.user.id !== ctx.data?.userId && ctx.user.global_role !== 'superadmin') {
            throw new Error('FORBIDDEN_USER_ACCESS');
        }
    };

    engine.tapBefore('USER_PASSWORD_CHANGE', assertSelfOrSuperAdmin);

    engine.registerService<{ userId: string; newPasswordHash: string }, { success: boolean }>(
        'USER_PASSWORD_CHANGE',
        async (ctx) => {
            await ctx.dal.batch([
                buildUpdateUserPasswordStatement(ctx.dal.db, ctx.data.userId, ctx.data.newPasswordHash),
                buildIncrementUserTokenVersionStatement(ctx.dal.db, ctx.data.userId)
            ]);
            return { success: true };
        }
    );

    engine.tapBefore('USER_PREFERENCES_SAVE', assertSelfOrSuperAdmin);

    engine.registerService<{ userId: string; timezone?: string; editor_split_mode?: string; list_page_size?: number; quick_action_shortcut?: string }, { success: boolean; metadata: Record<string, any> }>(
        'USER_PREFERENCES_SAVE',
        async (ctx) => {
            const existing = await findUserMetadataById(ctx.dal.db, ctx.data.userId);
            const merged = {
                ...existing,
                timezone: ctx.data.timezone ?? existing.timezone ?? 'auto',
                editor_split_mode: ctx.data.editor_split_mode ?? existing.editor_split_mode ?? 'split',
                list_page_size: ctx.data.list_page_size ?? existing.list_page_size ?? 20,
                quick_action_shortcut: ctx.data.quick_action_shortcut ?? existing.quick_action_shortcut ?? 'alt+k,cmd+k'
            };
            await ctx.dal.batch([
                buildUpdateUserMetadataStatement(ctx.dal.db, ctx.data.userId, JSON.stringify(merged))
            ]);
            return { success: true, metadata: merged };
        }
    );

    engine.registerService<{ usernameOrEmail: string; passwordPlain: string }, LoginContextResult>(
        'AUTH_LOGIN',
        async (ctx) => {
            try {
                const identifier = ctx.data.usernameOrEmail;
                const user = await findUserForAuth(ctx.dal.db, identifier);

                if (!user || !user.password_hash) {
                    return { success: false, error: 'USER_NOT_FOUND_OR_NO_PASSWORD' };
                }

                const isValid = await verifyPassword(ctx.data.passwordPlain, user.password_hash);
                if (!isValid) {
                    return { success: false, error: 'INVALID_CREDENTIALS' };
                }

                return {
                    success: true,
                    user: {
                        id: user.id,
                        email: user.email,
                        username: user.username,
                        global_role: user.global_role,
                        auth_provider: 'password'
                    }
                };
            } catch (e: any) {
                return { success: false, error: e.message || 'LOGIN_ERROR' };
            }
        }
    );

    engine.registerService<{ userId?: string }, { success: boolean }>('AUTH_LOGOUT', async (ctx) => {
        const targetUid = ctx.data?.userId || ctx.user?.id;
        if (targetUid && ctx.dal?.db) {
            await ctx.dal.batch([buildIncrementUserTokenVersionStatement(ctx.dal.db, targetUid)]);
        }
        return { success: true };
    });
}
