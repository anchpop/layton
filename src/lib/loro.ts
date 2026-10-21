import init from "loro-crdt/web/loro_wasm.js";
import wasmUrl from "loro-crdt/web/loro_wasm_bg.wasm?url";

// The default browser entry loads wasm with synchronous XMLHttpRequest, which
// cannot reach the service worker's cache offline. Async fetch can. Vite aliases
// every bare Loro import here, including ProseMirror's, so all containers still
// share the same constructors and wasm instance.
await init({ module_or_path: wasmUrl });
export * from "loro-crdt/web";
