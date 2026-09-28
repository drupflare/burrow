#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include <emscripten.h>

static const char* SCRIPT =
	"local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end\n"
	"local t = {}\n"
	"for i = 1, 20000 do t[i] = (i * 7) % 1000 end\n"
	"table.sort(t)\n"
	"local s = 0\n"
	"for i = 1, #t do s = s + t[i] end\n"
	"local parts = {}\n"
	"for i = 1, 3000 do parts[#parts + 1] = string.format('%d:%x', i, i * 31) end\n"
	"local str = table.concat(parts, ',')\n"
	"local words = 0\n"
	"for w in string.gmatch(str, '[^,]+') do words = words + #w end\n"
	"local m = {}\n"
	"for i = 1, 5000 do m['k' .. (i % 777)] = (m['k' .. (i % 777)] or 0) + i end\n"
	"local ms = 0\n"
	"for k, v in pairs(m) do ms = ms + v end\n"
	"return fib(20) + s + words + ms\n";

EMSCRIPTEN_KEEPALIVE int run(int n) {
	long long acc = 0;
	for (int k = 0; k < n; ++k) {
		lua_State* L = luaL_newstate();
		luaL_openlibs(L);
		if (luaL_loadstring(L, SCRIPT) != LUA_OK) return -1;
		lua_call(L, 0, 1);
		acc = acc * 31 + lua_tointeger(L, -1);
		lua_close(L);
	}
	return (int) acc;
}
