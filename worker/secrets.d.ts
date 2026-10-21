/** Set with wrangler secret put; never part of the browser bundle. */
interface Env { VLLM_API_KEY: string; }

declare module "*.wasm" { const module: WebAssembly.Module; export default module; }
