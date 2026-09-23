import { Router, type IRouter } from "express";
import healthRouter   from "./health";
import gamertagRouter from "./gamertag";
import authRouter     from "./auth";
import activityRouter from "./activity";
import settingsRouter from "./settings";
import statusRouter   from "./status";
import botRouter      from "./bot";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(gamertagRouter);
router.use(activityRouter);
router.use(settingsRouter);
router.use(statusRouter);
router.use(botRouter);

export default router;
