declare module '*?raw' {
	const contents: string;
	export default contents;
}

declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}

declare module '*.bin' {
	const bytes: ArrayBuffer;
	export default bytes;
}
