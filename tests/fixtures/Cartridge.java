package fixture;

import org.teavm.jso.JSBody;
import org.teavm.jso.JSBodyImport;

/**
 * The program `@drupflare/cartridge` drives in its Java lane.
 *
 * <p>Reads the script a cartridge wrote, which for an ahead-of-time compiled program is data rather
 * than code: the path arrives as the last element of argv and the bytes come back over a module the
 * adapter supplies. Throws when the script asks it to, so the lane can drive a nonzero exit.
 */
public class Cartridge {

	@JSBody(
		params = "path",
		imports = @JSBodyImport(alias = "fs", fromModule = "cartridge:fs"),
		script = "return fs.readText(path);"
	)
	private static native String readText(String path);

	public static void main(String[] args) {
		System.out.println("argv:" + String.join(",", args));
		if (args.length == 0) return;
		String source = readText(args[args.length - 1]);
		System.out.println("read:" + source);
		if (source != null && source.startsWith("throw")) {
			throw new IllegalStateException("the cartridge asked for a failure");
		}
	}
}
