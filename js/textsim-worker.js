// Runs the similarity maths off the main thread so the page stays smooth.
import { analyse } from "./textsim.js";

self.onmessage = e => {
  const { id, titles, texts, edges } = e.data;
  const result = analyse(titles, t => texts[t] || "", edges);
  self.postMessage({ id, result });
};
