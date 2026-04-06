import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";
import { env } from "../config/env.js";

/**
 * Serves the one-liner embed <script> snippet that customers paste into their websites.
 * The snippet dynamically loads the full widget bundle from the CDN/public URL.
 */
export const getWidgetScript = asyncHandler(async (req, res) => {
  const widgetUrl = env.widgetPublicUrl;
  const scriptOrigin = new URL(widgetUrl).origin;

  const script = `
(function() {
  const currentScript = document.currentScript;
  const apiKey = currentScript && currentScript.getAttribute('data-api-key');
  if (!apiKey) return;
  const origin = "${scriptOrigin}";
  const s = document.createElement('script');
  s.src = "${widgetUrl}";
  s.setAttribute('data-api-key', apiKey);
  s.setAttribute('data-api-url', origin);
  document.head.appendChild(s);
})();
  `;
  res.type("application/javascript").send(script);
});
