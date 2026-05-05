
const XHRFactory = {
	config: {
		withCredentials: false,
		customHeaders: [
			{ header: null, value: null }
		]
	},

	/**
	 * Rewrites Azure Blob Storage URLs to go through the /api/proxy-blob
	 * endpoint, bypassing browser CORS restrictions entirely.
	 */
	proxyAzureUrl: function (url) {
		if (url && url.includes('.blob.core.windows.net')) {
			return '/api/proxy-blob?url=' + encodeURIComponent(url);
		}
		return url;
	},

	createXMLHttpRequest: function () {
		let xhr = new XMLHttpRequest();

		// Intercept xhr.open to rewrite Azure Blob URLs through the proxy
		let baseOpen = xhr.open;
		let customHeaders = this.config.customHeaders;
		let proxyFn = this.proxyAzureUrl;

		xhr.open = function () {
			let args = [].slice.call(arguments);
			// args[1] is the URL — rewrite it if it targets Azure Blob Storage
			if (args[1]) {
				args[1] = proxyFn(args[1]);
			}
			baseOpen.apply(this, args);

			// Apply custom headers if configured
			if (customHeaders &&
				Array.isArray(customHeaders) &&
				customHeaders.length > 0) {
				customHeaders.forEach(function (customHeader) {
					if (!!customHeader.header && !!customHeader.value) {
						xhr.setRequestHeader(customHeader.header, customHeader.value);
					}
				});
			}
		};

		return xhr;
	}
};

export { XHRFactory };