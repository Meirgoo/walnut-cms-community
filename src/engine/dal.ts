import type {
    D1Database,
    D1PreparedStatement,
    D1Result,
    R2Bucket,
    R2Object,
    R2ObjectBody,
    R2PutOptions,
    KVNamespace
} from '@cloudflare/workers-types';
import type { Site } from './types';
import { findSiteById, findSiteByPrimaryDomain, findFirstActiveSite } from './core/dal';

export * from './core/dal';

export type R2PutValue = Parameters<R2Bucket['put']>[1];

export interface DALBindings {
    DB: D1Database;
    BUCKET?: R2Bucket;
    BUCKET_BACKUP?: R2Bucket;
    KV?: KVNamespace;
}

export class DAL {
    public readonly db: D1Database;
    public readonly bucket?: R2Bucket;
    public readonly backupBucket?: R2Bucket;
    public readonly kv?: KVNamespace;

    constructor(bindings: DALBindings) {
        this.db = bindings.DB;
        this.bucket = bindings.BUCKET;
        this.backupBucket = bindings.BUCKET_BACKUP;
        this.kv = bindings.KV;
    }

    public stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
        const prepared = this.db.prepare(sql);
        const bindParams = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params;
        return bindParams.length > 0 ? prepared.bind(...bindParams) : prepared;
    }

    public async queryFirst<T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = []
    ): Promise<T | null> {
        try {
            const statement = this.stmt(sql, ...params);
            return await statement.first<T>();
        } catch {
            return null;
        }
    }

    public async queryAll<T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = []
    ): Promise<T[]> {
        try {
            const statement = this.stmt(sql, ...params);
            const res = await statement.all<T>();
            return res.results ?? [];
        } catch {
            return [];
        }
    }

    public async execute(sql: string, params: unknown[] = []): Promise<D1Result<Record<string, unknown>>> {
        const statement = this.stmt(sql, ...params);
        return await statement.run<Record<string, unknown>>();
    }

    public async batch<T = Record<string, unknown>>(
        statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> {
        if (statements.length === 0) {
            return [];
        }
        return await this.db.batch<T>(statements);
    }

    public async findSiteById(siteId: string): Promise<Site | null> {
        return await findSiteById(this.db, siteId);
    }

    public async findSiteByPrimaryDomain(domain: string): Promise<Site | null> {
        return await findSiteByPrimaryDomain(this.db, domain);
    }

    public async findFirstActiveSite(): Promise<Site | null> {
        return await findFirstActiveSite(this.db);
    }

    private normalizeR2Key(key: string): string {
        return key.replace(/^\/+/, '');
    }

    public async putBackupObject(
        key: string,
        value: R2PutValue,
        options?: R2PutOptions
    ): Promise<R2Object | null> {
        const targetBucket = this.backupBucket ?? this.bucket;
        if (!targetBucket) {
            throw new Error('[DAL]Neither BUCKET_BACKUP nor primary BUCKET binding is available.');
        }
        return await targetBucket.put(this.normalizeR2Key(key), value, options);
    }

    public async getBackupObject(key: string): Promise<R2ObjectBody | null> {
        const targetBucket = this.backupBucket ?? this.bucket;
        if (!targetBucket) {
            return null;
        }
        return await (targetBucket as any).get(this.normalizeR2Key(key));
    }

}

export function createDAL(bindings: DALBindings): DAL {
    return new DAL(bindings);
}
