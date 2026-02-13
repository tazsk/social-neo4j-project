import jwt from "jsonwebtoken";
import User from "../models/User.js";

/**
 * Backward-compatible DEFAULT export (AuthRoutes.js imports this as `protect`)
 * Strict auth: requires a valid token.
 *
 * Accepts:
 *  1) Authorization: Bearer <token>
 *  2) (NEW) query token for SSE: ?token=<token>
 */
const protect = async (req, res, next) => {
  try {
    const token =
      (req.headers.authorization && req.headers.authorization.split(" ")[1]) ||
      req.query.token;

    if (!token) return res.status(401).json({ error: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Keep fallbacks so we don't break if payload key differs
    const userId = decoded.id || decoded.userId || decoded._id;
    if (!userId) return res.status(401).json({ error: "Invalid token payload" });

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: "User not found" });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

export default protect;

// Named exports used elsewhere
export const authMiddleware = protect;

/**
 * Optional auth: tries to attach req.user if token exists & is valid.
 * NEVER blocks the request.
 * Ideal for SSE endpoints where EventSource can't send Authorization headers.
 */
export const optionalAuthMiddleware = async (req, res, next) => {
  try {
    const token =
      (req.headers.authorization && req.headers.authorization.split(" ")[1]) ||
      req.query.token;

    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id || decoded.userId || decoded._id;
    if (!userId) return next();

    const user = await User.findById(userId);
    if (user) req.user = user;

    return next();
  } catch {
    return next();
  }
};
