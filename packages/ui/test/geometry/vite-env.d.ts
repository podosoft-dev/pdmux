/** Vite resolves a bare CSS import; TypeScript needs to be told it exists. */
declare module '*.css';

/** `?raw` hands over a file's text; the soft-wrap check loads the engine's golden frame so. */
declare module '*?raw' {
	const text: string;
	export default text;
}
