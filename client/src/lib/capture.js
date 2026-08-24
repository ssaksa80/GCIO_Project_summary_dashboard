/**
 * Chart capture for rich exports (SPEC §8): serialize every
 * [data-export-chart] SVG into a 2x PNG data URL, inlining computed
 * styles so theme tokens survive outside the live DOM.
 */

const STYLED = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-size", "font-family", "font-weight", "letter-spacing", "text-anchor", "dominant-baseline"];

function inlineStyles(source, clone) {
  const srcAll = [source, ...source.querySelectorAll("*")];
  const dstAll = [clone, ...clone.querySelectorAll("*")];
  for (let i = 0; i < srcAll.length; i += 1) {
    const computed = window.getComputedStyle(srcAll[i]);
    for (const prop of STYLED) {
      const value = computed.getPropertyValue(prop);
      if (value) dstAll[i].setAttribute(prop, value);
    }
  }
}

/** Capture all export-tagged charts. Never throws; failures yield []. */
export async function captureCharts() {
  try {
    const surface = getComputedStyle(document.documentElement).getPropertyValue("--chart-surface").trim() || "#161a23";
    const nodes = [...document.querySelectorAll("[data-export-chart]")];
    const captures = await Promise.all(nodes.map(async (wrap) => {
      const svg = wrap.querySelector("svg");
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return null;
      const clone = svg.cloneNode(true);
      inlineStyles(svg, clone);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", rect.width);
      clone.setAttribute("height", rect.height);
      const markup = new XMLSerializer().serializeToString(clone);
      const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = svgUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(rect.width * 2);
      canvas.height = Math.round(rect.height * 2);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = surface;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { id: wrap.getAttribute("data-export-chart"), dataUrl: canvas.toDataURL("image/png") };
    }));
    return captures.filter(Boolean);
  } catch {
    return [];
  }
}
