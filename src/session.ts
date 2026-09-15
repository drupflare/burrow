import { mkdirp } from './adapt.js';
import type { Interpreter, RuntimeIo } from './runtime.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encodes a payload that may already be bytes, so no caller builds a `TextEncoder`. */
export function toBytes(value: string | Uint8Array): Uint8Array {
	return typeof value === 'string' ? encoder.encode(value) : value;
}

/** Decodes bytes as UTF-8. */
export function fromBytes(value: Uint8Array): string {
	return decoder.decode(value);
}

/**
 * What one evaluation produced.
 *
 * Bytes are always available; the decoded conveniences exist so a caller never has to construct a
 * `TextDecoder` for the common case.
 *
 * @since 1.0.0
 */
export interface RunResult {
	/** the guest's exit status; 0 is success by the usual convention */
	exitCode: number;
	/** raw stdout */
	stdout: Uint8Array;
	/** raw stderr */
	stderr: Uint8Array;
	/** stdout decoded as UTF-8 */
	readonly stdoutText: string;
	/** stderr decoded as UTF-8 */
	readonly stderrText: string;
	/** stdout decoded as UTF-8; the same as {@link RunResult.stdoutText}, as a call */
	text(): string;
	/**
	 * stdout parsed as JSON.
	 *
	 * @throws {SyntaxError} when stdout is not JSON
	 */
	json<T = unknown>(): T;
}

export interface SessionOptions {
	/** directory scripts are written into; created on first use */
	scriptDir?: string;
	/** basename {@link Session.eval} writes its source to, inside `scriptDir` */
	scriptName?: string;
	/** builds the argv for a script path; the default is the path alone */
	argv?: (scriptPath: string) => string[];
	/** files written into the guest filesystem before the first evaluation */
	files?: Record<string, string | Uint8Array>;
}

export const DEFAULT_SCRIPT_DIR = '/burrow';
export const DEFAULT_SCRIPT_NAME = 'main';

/** @internal how a session gets at its interpreter; the registry supplies this */
export interface SessionHost {
	instantiate(io: RuntimeIo): Promise<Interpreter>;
	release(): void;
}

/**
 * A resident interpreter that keeps its state between evaluations.
 *
 * This is the REPL and CLI shape: globals, loaded classes and the filesystem all survive from one
 * `eval` to the next, because the interpreter is booted once and the session holds its lease for its
 * whole lifetime. That lease is also what stops the budget evicting the interpreter mid-conversation.
 *
 * @example
 * ```ts
 * await using sh = await burrow.session('php');
 *
 * await sh.evalText('<?php $composer = json_decode(file_get_contents("composer.json"), true);');
 * const name = await sh.evalText('<?php echo $composer["name"];');
 * ```
 *
 * @since 1.0.0
 */
export class Session implements AsyncDisposable {
	private readonly host: SessionHost;
	private readonly scriptDir: string;
	private readonly scriptPath: string;
	private readonly buildArgv: (path: string) => string[];
	private readonly seed: Record<string, string | Uint8Array>;
	private interp: Interpreter | null = null;
	private seeded = false;
	private disposed = false;
	private out: number[] = [];
	private err: number[] = [];
	/** built once and handed to the boot, because the interpreter keeps whichever io it was given */
	private readonly io: RuntimeIo = {
		print: (line) => pushLine(this.out, line),
		printErr: (line) => pushLine(this.err, line)
	};

	/** @internal constructed by {@link Burrow.session}, not directly */
	constructor(host: SessionHost, options: SessionOptions = {}) {
		this.host = host;
		this.scriptDir = (options.scriptDir ?? DEFAULT_SCRIPT_DIR).replace(/\/+$/, '');
		this.scriptPath = `${this.scriptDir}/${options.scriptName ?? DEFAULT_SCRIPT_NAME}`;
		this.buildArgv = options.argv ?? ((path: string) => [path]);
		this.seed = options.files ?? {};
	}

	/** the booted interpreter, or `null` before the first evaluation */
	get interpreter(): Interpreter | null {
		return this.interp;
	}

	/**
	 * Runs one source string and answers everything it produced.
	 *
	 * @throws {LeaseError} when the session has been disposed
	 */
	async eval(source: string | Uint8Array): Promise<RunResult> {
		const interpreter = await this.boot();
		// replaced per run, not appended to: the interpreter is booted once and keeps whichever io it
		// was given, so a shared buffer would leak one evaluation's late output into the next
		this.out = [];
		this.err = [];

		interpreter.FS.writeFile(this.scriptPath, toBytes(source));
		const status = await interpreter.callMain(this.buildArgv(this.scriptPath));

		return makeResult(typeof status === 'number' ? status : 0, this.out, this.err);
	}

	/** Runs one source string and answers its stdout, decoded. */
	async evalText(source: string | Uint8Array): Promise<string> {
		return (await this.eval(source)).stdoutText;
	}

	/**
	 * Runs one source string and parses its stdout as JSON.
	 *
	 * @throws {SyntaxError} when the guest did not write JSON
	 */
	async evalJson<T = unknown>(source: string | Uint8Array): Promise<T> {
		return (await this.eval(source)).json<T>();
	}

	/** Writes a file into the guest filesystem, creating parents as needed. */
	async write(path: string, data: string | Uint8Array): Promise<void> {
		const interpreter = await this.boot();
		writeInto(interpreter, path, data);
	}

	/** Reads a file back out of the guest filesystem. */
	async read(path: string): Promise<Uint8Array> {
		const interpreter = await this.boot();
		const data = interpreter.FS.readFile(path);
		return typeof data === 'string' ? toBytes(data) : data;
	}

	/** Reads a file back out of the guest filesystem, decoded as UTF-8. */
	async readText(path: string): Promise<string> {
		return fromBytes(await this.read(path));
	}

	/** Releases the lease. Idempotent; the interpreter itself stays cached for the next session. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.host.release();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.dispose();
	}

	private async boot(): Promise<Interpreter> {
		const interpreter = await this.host.instantiate(this.io);
		this.interp = interpreter;
		if (!this.seeded) {
			this.seeded = true;
			mkdirp(interpreter.FS, this.scriptDir);
			for (const [path, data] of Object.entries(this.seed)) {
				writeInto(interpreter, path, data);
			}
		}
		return interpreter;
	}
}

function writeInto(interpreter: Interpreter, path: string, data: string | Uint8Array): void {
	const slash = path.lastIndexOf('/');
	if (slash > 0) mkdirp(interpreter.FS, path.slice(0, slash));
	interpreter.FS.writeFile(path, toBytes(data));
}

/** appends a line and its newline, so the collected bytes match what the guest actually wrote */
function pushLine(into: number[], line: string): undefined {
	for (const byte of encoder.encode(line)) into.push(byte);
	into.push(10);
	return undefined;
}

/** @internal exported for the gate, which builds results without booting a runtime */
export function makeResult(exitCode: number, out: number[], err: number[]): RunResult {
	const stdout = new Uint8Array(out);
	const stderr = new Uint8Array(err);
	return {
		exitCode,
		stdout,
		stderr,
		get stdoutText() {
			return fromBytes(stdout);
		},
		get stderrText() {
			return fromBytes(stderr);
		},
		text() {
			return fromBytes(stdout);
		},
		json<T = unknown>(): T {
			return JSON.parse(fromBytes(stdout)) as T;
		}
	};
}
