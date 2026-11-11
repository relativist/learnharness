"use strict";

const http = require("node:http");

// A proxy must never intercept the app's private server or OAuth callback.
const LOOPBACK = "localhost,127.0.0.1,::1,[::1]";

/** Read exported shell variables without changing the caller's environment.
 * @param {Record<string, string | undefined>} env */
function proxyEnvironment(env) {
	const fallback = env.all_proxy || env.ALL_PROXY;
	const httpProxy = env.http_proxy || env.HTTP_PROXY || fallback;
	const httpsProxy = env.https_proxy || env.HTTPS_PROXY || fallback || httpProxy;
	if (!httpProxy && !httpsProxy) return null;
	for (const value of [httpProxy, httpsProxy]) {
		if (!value) continue;
		try {
			const url = new URL(value);
			if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error();
		} catch {
			// Proxy URLs may contain passwords; never include the value or cause.
			throw new Error("Invalid proxy configuration. Use an HTTP or HTTPS proxy URL in the proxy environment variables.");
		}
	}
	const noProxy = [env.no_proxy || env.NO_PROXY, LOOPBACK].filter(Boolean).join(",");
	return {
		...env,
		HTTP_PROXY: httpProxy, http_proxy: httpProxy,
		HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy,
		NO_PROXY: noProxy, no_proxy: noProxy,
	};
}

/** Configure both Node fetch and HTTP(S) clients before their first request.
 * Electron 44.9.3 includes Node 24.22; this API requires Node >=24.14.
 * @param {Record<string, string | undefined>} [env] */
function configureEnvironmentProxy(env = process.env) {
	const proxyEnv = proxyEnvironment(env);
	if (!proxyEnv) return () => {};
	if (typeof http.setGlobalProxyFromEnv !== "function") {
		throw new Error("Environment proxy support requires Node.js 24.14 or newer.");
	}
	try {
		return http.setGlobalProxyFromEnv(proxyEnv);
	} catch {
		throw new Error("Could not configure the environment proxy. Check the HTTP(S) proxy environment variables.");
	}
}

module.exports = { proxyEnvironment, configureEnvironmentProxy };
