// Worker secrets are provisioned outside wrangler.jsonc.
interface Env { VLLM_API_KEY: string; }
declare module "*.wasm" { const module: WebAssembly.Module; export default module; }
