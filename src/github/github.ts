import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { GithubHandlerFunction } from "../interfaces";
import {
  handleClosed,
  handleCreated,
  handleDeleted,
  handleLocked,
  handleOpened,
  handleReopened,
  handleUnlocked,
} from "./githubHandlers";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const app = express();
app.use(
  express.json({
    verify: (req: RawBodyRequest, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

function verifySignature(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
) {
  if (!config.GITHUB_WEBHOOK_SECRET) {
    return next();
  }

  const signature = req.header("x-hub-signature-256");
  if (!signature || !req.rawBody) {
    return res.status(401).json({ msg: "missing signature" });
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", config.GITHUB_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    return res.status(401).json({ msg: "invalid signature" });
  }

  next();
}

export function initGithub() {
  if (!config.GITHUB_WEBHOOK_SECRET) {
    console.warn(
      "GITHUB_WEBHOOK_SECRET is not set — webhook requests will NOT be verified.",
    );
  }

  app.get("", (_, res) => {
    res.json({ msg: "github webhooks work" });
  });

  const githubActions: {
    [key: string]: GithubHandlerFunction;
  } = {
    opened: (req) => handleOpened(req),
    created: (req) => handleCreated(req),
    closed: (req) => handleClosed(req),
    reopened: (req) => handleReopened(req),
    locked: (req) => handleLocked(req),
    unlocked: (req) => handleUnlocked(req),
    deleted: (req) => handleDeleted(req),
  };

  app.post("/", verifySignature, async (req, res) => {
    const githubAction = githubActions[req.body.action];
    githubAction && githubAction(req);
    res.json({ msg: "ok" });
  });

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

export default app;
