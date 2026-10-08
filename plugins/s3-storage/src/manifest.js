const secretRef = {
  type: "object",
  format: "secret-ref",
  title: "Paperclip secret reference",
  properties: {
    type: { type: "string", const: "secret_ref" },
    secretId: { type: "string", format: "uuid" },
    version: { type: ["string", "integer"] },
  },
  required: ["type", "secretId"],
  additionalProperties: false,
};

const uuid = { type: "string", format: "uuid" };
const uploadProperties = {
  idempotencyKey: uuid,
  projectId: uuid,
  filename: { type: "string", minLength: 1, maxLength: 255 },
  contentType: { type: "string", minLength: 1, maxLength: 160 },
  size: { type: "integer", minimum: 1, maximum: 67108864 },
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
};
const uploadSchema = {
  type: "object", properties: uploadProperties,
  required: ["idempotencyKey", "filename", "contentType", "size", "sha256"], additionalProperties: false,
};
const objectIdSchema = {
  type: "object", properties: { objectId: uuid }, required: ["objectId"], additionalProperties: false,
};
const listSchema = {
  type: "object", properties: { projectId: uuid, limit: { type: "integer", minimum: 1, maximum: 100 } },
  additionalProperties: false,
};
const bucketSchema = {
  type: "object", properties: { bucket: { type: "string", minLength: 3, maxLength: 63, pattern: "^[a-z0-9][a-z0-9.-]*[a-z0-9]$" } },
  required: ["bucket"], additionalProperties: false,
};

const route = (routeKey, method, path) => ({
  routeKey, method, path, auth: "board", capability: "api.routes.register",
  companyResolution: { from: "query", key: "companyId" },
});

const manifest = {
  id: "journey-studios.s3-storage",
  apiVersion: 1,
  version: "0.2.1",
  displayName: "S3 Storage",
  description: "Private, company-scoped S3-compatible media storage for AWS S3, Cloudflare R2 and Backblaze B2.",
  author: "Journey Studios",
  categories: ["connector"],
  capabilities: [
    "api.routes.register",
    "agent.tools.register",
    "companies.read",
    "projects.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "secrets.read-ref",
    "http.outbound",
    "activity.log.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: { namespaceSlug: "s3_storage", migrationsDir: "migrations", coreReadTables: ["companies"] },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      provider: { type: "string", title: "Provider", enum: ["backblaze", "aws", "r2", "s3"], default: "backblaze" },
      endpoint: { type: "string", title: "S3 endpoint", description: "HTTPS endpoint for R2 or Backblaze B2. Leave blank for AWS S3.", format: "uri" },
      region: { type: "string", title: "Region", description: "Provider region; use auto for Cloudflare R2." },
      bucket: { type: "string", title: "Bucket", maxLength: 63 },
      prefix: { type: "string", title: "Object key prefix", default: "paperclip", maxLength: 300 },
      defaultProjectId: { type: "string", title: "Default Paperclip project ID", format: "uuid", description: "Optional company-owned project assigned to uploads that omit projectId." },
      repositoryUrl: { type: "string", title: "Repository URL", description: "Optional repository associated with this company storage mapping." },
      forcePathStyle: { type: "boolean", title: "Force path-style addressing", default: false },
      maxUploadBytes: { type: "integer", title: "Maximum upload size in bytes", minimum: 1, maximum: 67108864, default: 67108864 },
      urlTtlSeconds: { type: "integer", title: "Signed URL lifetime in seconds", minimum: 60, maximum: 900, default: 300 },
      accessKeyIdRef: { ...secretRef, title: "Access key ID secret" },
      secretAccessKeyRef: { ...secretRef, title: "Secret access key secret" },
      sessionTokenRef: { ...secretRef, title: "Session token secret (optional)" },
      allowProvisioning: { type: "boolean", title: "Allow bucket creation", description: "Requires bucket-creation permission on the same credential refs.", default: false },
      enableNativeAttachments: { type: "boolean", title: "Bridge native attachments", description: "Allow the external S3-compatible bridge to route Paperclip native attachment operations through this company storage configuration.", default: false },
    },
  },
  apiRoutes: [
    route("status", "GET", "/status"),
    route("connection-test", "POST", "/connection-test"),
    route("objects-list", "GET", "/objects"),
    route("upload-prepare", "POST", "/uploads"),
    route("upload-finalize", "POST", "/uploads/:objectId/finalize"),
    route("object-download", "GET", "/objects/:objectId/download"),
    route("bucket-create", "POST", "/buckets"),
    route("native-prepare", "POST", "/native/prepare"),
    route("native-finalize", "POST", "/native/finalize"),
    route("native-read", "POST", "/native/read"),
    route("native-delete", "POST", "/native/delete"),
    route("mcp", "POST", "/mcp"),
    route("mcp-get", "GET", "/mcp"),
  ],
  tools: [
    { name: "s3_storage_status", displayName: "S3 Storage Status", description: "Read the configured company storage provider and safe connection settings.", parametersSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "s3_storage_test_connection", displayName: "Test S3 Storage Connection", description: "Verify credentials and bucket access without changing storage.", parametersSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "s3_storage_list_objects", displayName: "List Stored Media", description: "List ready media metadata visible to this company, optionally limited to a project.", parametersSchema: listSchema },
    { name: "s3_storage_prepare_upload", displayName: "Prepare Media Upload", description: "Create an idempotent upload intent and a short-lived direct-to-provider PUT URL. Upload bytes to that URL, then finalize.", parametersSchema: uploadSchema },
    { name: "s3_storage_finalize_upload", displayName: "Finalize Media Upload", description: "Stream and hash the uploaded provider object, then publish an immutable content-addressed copy to the catalog.", parametersSchema: objectIdSchema },
    { name: "s3_storage_read_link", displayName: "Create Media Read Link", description: "Create a short-lived private download URL for one ready media object in this company.", parametersSchema: objectIdSchema },
    { name: "s3_storage_create_bucket", displayName: "Create Storage Bucket", description: "Create a provider bucket only when provisioning is explicitly enabled in company settings.", parametersSchema: bucketSchema },
  ],
};

export default manifest;
