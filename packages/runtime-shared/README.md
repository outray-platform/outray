# @outray/runtime-shared

MIT-licensed server primitives shared by the public edge and private platform. Use explicit subpaths for protocol types, host/TLS helpers, bounded Redis queues and payload-free tunnel accounting. This is not a client instrumentation SDK.

Product catalogs, entitlement policies and database schemas are deliberately excluded. Accounting preserves the existing `record_product_usage` SQL-function contract; this package does not provision a platform database.
