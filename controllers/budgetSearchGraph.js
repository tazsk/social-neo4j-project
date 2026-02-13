// backend/controllers/budgetSearchGraph.js
import { StateGraph, START, END } from "@langchain/langgraph";

/**
 * Build a small LangGraph state machine that orchestrates:
 * 1) Kroger pipeline
 * 2) Walmart pipeline
 * 3) Budget selection / final payload build
 *
 * We inject the existing functions from KrogerController so we don't refactor your pipeline files.
 */
export function buildBudgetSearchGraphRunner({
  runKrogerSearchPipeline,
  runWalmartMatchByIndexDetailed,
  buildFinalPayload, // (krogerResult, walmartResult, options) => payload
}) {
  const graph = new StateGraph({
    channels: {
      query: null,
      zip: null,
      user: null,
      budgetSearch: null,
      passCount: null,
      chooseMaxKroger: null,
      chooseMaxWalmart: null,
      onPhase: null,

      krogerResult: null,
      walmartResult: null,
      payload: null,
    },
  });

  graph.addNode("kroger", async (state) => {
    const onPhase = state.onPhase;
    const krogerResult = await runKrogerSearchPipeline({
      query: state.query,
      zip: state.zip,
      user: state.user,
      passCount: state.passCount ?? 20,
      chooseMax: state.chooseMaxKroger ?? 2,
      onPhase,
    });
    return { krogerResult };
  });

  graph.addNode("walmart", async (state) => {
    const onPhase = state.onPhase;
    if (typeof onPhase === "function") onPhase("walmart");

    const kroger = state.krogerResult || {};
    const ingredients = Array.isArray(kroger.ingredients) ? kroger.ingredients : [];

    // In budget mode: search Walmart for ALL ingredients
    // Otherwise: only unmatched (legacy behavior)
    let walmartTerms = ingredients;
    if (!state.budgetSearch) {
      const matched = new Set(kroger.matchedInKroger || []);
      walmartTerms = ingredients.filter((ing) => !matched.has(ing));
    }

    const walmartResult = await runWalmartMatchByIndexDetailed(walmartTerms, {
      passCount: state.passCount ?? 20,
      chooseMax: state.chooseMaxWalmart ?? 2,
    });

    return { walmartResult };
  });

  graph.addNode("select", async (state) => {
    const onPhase = state.onPhase;
    if (typeof onPhase === "function") onPhase("selecting");

    const payload = buildFinalPayload(state.krogerResult, state.walmartResult, {
      budgetSearch: Boolean(state.budgetSearch),
    });

    return { payload };
  });

  graph.addEdge(START, "kroger");
  graph.addEdge("kroger", "walmart");
  graph.addEdge("walmart", "select");
  graph.addEdge("select", END);

  return graph.compile();
}
