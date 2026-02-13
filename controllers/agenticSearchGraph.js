// backend/controllers/agenticSearchGraph.js
import { StateGraph, START, END } from "@langchain/langgraph";

/**
 * Agentic LangGraph:
 * kroger -> walmart -> select -> add_to_cart -> end
 *
 * We inject your existing KrogerController functions to avoid refactoring.
 */
export function buildAgenticSearchGraphRunner({
  runKrogerSearchPipeline,
  runWalmartMatchByIndexDetailed,
  buildFinalPayload,
  addAllKrogerItemsToCart, // ({ user, payload, returnTo, onPhase, onCartEvent }) => cartAddResult
}) {
  const graph = new StateGraph({
    channels: {
      query: null,
      zip: null,
      user: null,
      budgetSearch: null,
      autoAdd: null,
      returnTo: null,

      passCount: null,
      chooseMaxKroger: null,
      chooseMaxWalmart: null,

      onPhase: null,
      onCartEvent: null, // ✅ NEW

      krogerResult: null,
      walmartResult: null,
      payload: null,
      cartAdd: null,
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

    // budget mode: search walmart for ALL ingredients
    // non-budget: search walmart only for unmatched
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

  graph.addNode("add_to_cart", async (state) => {
    const onPhase = state.onPhase;
    const onCartEvent = state.onCartEvent;

    // Only act if enabled
    if (!state.autoAdd) return { cartAdd: null };

    // Only possible for authenticated users (because cart add uses user token)
    if (!state.user?._id) return { cartAdd: { ok: false, error: "not_authenticated" } };

    if (typeof onPhase === "function") onPhase("adding");

    const cartAdd = await addAllKrogerItemsToCart({
      user: state.user,
      payload: state.payload,
      returnTo: state.returnTo,
      onPhase,
      onCartEvent, // ✅ NEW
    });

    return { cartAdd };
  });

  graph.addEdge(START, "kroger");
  graph.addEdge("kroger", "walmart");
  graph.addEdge("walmart", "select");
  graph.addEdge("select", "add_to_cart");
  graph.addEdge("add_to_cart", END);

  return graph.compile();
}
