declare module "#noise-codec" {
	export const memory: { buffer: ArrayBuffer };
	export function scratch_ptr(): number;
	export function start(): number;
	export function verify(id: number, len: number): number;
	export function request(id: number, len: number): number;
	export function response(id: number, len: number): number;
	export function proof(id: number, len: number): number;
	export function upload_chunk(
		id: number,
		len: number,
		sequence: number,
	): number;
	export function close(id: number): void;
}
