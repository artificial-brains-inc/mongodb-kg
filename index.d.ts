declare module "mongodb-kg" {
  import type { Connection, Model, Schema } from "mongoose";

  export function createGraphModels(opts: {
    node: { name: string; typeEnum?: string[]; customFields?: Record<string, any> };
    edge: { name: string; relationshipEnum?: string[]; customFields?: Record<string, any> };
    connection: Connection;
  }): { NodeModel: Model<any>; EdgeModel: Model<any> };

  export function kgInit(opts: {
    nodesModel: Model<any>;
    edgesModel: Model<any>;
    repos?: Record<string, any>;
  }): void;

  export function bindModel(
    modelOrSchema: Model<any> | Schema,
    config: {
      node: (doc: any) => { id: string } & Record<string, any>;
      edges?: (doc: any, ctx?: any) => Array<Record<string, any>> | Promise<Array<Record<string, any>>>;
      cleanup?: (doc: any, ctx?: any) => Array<Record<string, any>>;
      keepExtra?: { edges?: boolean } | boolean;
      onError?: (err: Error, hook: string) => void;
    }
  ): Model<any> | Schema;

  export function kgBulkSync(opts: {
    desiredNodes?: Array<Record<string, any>>;
    desiredEdges?: Array<Record<string, any>>;
    keepExtra?: { edges?: boolean } | boolean;
    models?: Array<{ model: Model<any>; query?: any; label?: string }>;
    mode?: "save" | "findOneAndUpdate";
    concurrency?: number;
    maxPerModel?: number;
    onError?: ((err: Error, meta?: any) => void) | null;
  }): Promise<any>;
}
