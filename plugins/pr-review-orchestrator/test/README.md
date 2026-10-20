# Isolated integration tests

The suite deliberately uses a single disposable PGlite instance, truncating the plugin table before each test. Tests do not connect to the Paperclip runtime or production GitHub. The test helper exposes only the subset of the SDK used for queue operations. The following are separate production gates: host webhook ingress/HMAC, RPC `requestWakeup`, actual code review, and JOU-490 official GitHub publication.
