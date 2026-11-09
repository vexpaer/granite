# Basic sandbox plugin

This fixture is a complete untrusted iframe plugin package for the Granite SDK. It requests only
its namespaced storage and a settings slot, increments a local counter through checked RPC, emits a
namespaced event, and renders a small page inside the sandbox.

Build the installable package from the repository root:

```powershell
node packages/core/examples/basic-plugin/build.mjs
```

The result is `packages/core/examples/basic-plugin/dist/example.basic.granite.zip`. The build script
computes a standards-compliant SHA-256 SRI value over `main.js` before writing the manifest and ZIP.
The package remains untrusted even though it is shipped with Granite. Trusted ESM activation needs
an explicit persisted user grant outside the manifest.

The example uses direct DOM APIs only because it is an iframe plugin. Worker plugins have no DOM and
should register serializable UI contributions or expose commands through checked RPC instead.
