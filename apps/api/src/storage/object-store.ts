export type ObjectBody = Uint8Array | string | Blob;

export interface ObjectStore {
  put(key: string, body: ObjectBody, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  presignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  delete(key: string): Promise<void>;
  close(): void | Promise<void>;
}
