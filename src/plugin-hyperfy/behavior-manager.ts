import { IAgentRuntime, logger } from "@elizaos/core";
import { EMOTES_LIST } from "./constants";
import { AgentControls } from "./controls";

const TIME_INTERVAL = 30000;

export class BehaviorManager {
  private isRunning: boolean = false;
  private runtime: IAgentRuntime;
  
  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Starts the behavior loop
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn("[BehaviorManager] Already running");
      return;
    }

    this.isRunning = true;
    logger.info("[BehaviorManager] Starting behavior loop");

    this.runLoop();
  }

  /**
   * Stops the behavior loop
   */
  public stop(): void {
    if (!this.isRunning) {
      logger.warn("[BehaviorManager] Not running");
      return;
    }

    this.isRunning = false;
    logger.info("[BehaviorManager] Stopped behavior loop");
  }

  /**
   * Main loop that waits for each behavior to finish
   */
  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.executeBehavior();
      } catch (error) {
        logger.error("[BehaviorManager] Error in behavior:", error);
      }

      // Short delay between behaviors
      await new Promise((resolve) => setTimeout(resolve, TIME_INTERVAL));
    }
  }

  /**
   * Executes a behavior
   */
  private async executeBehavior(): Promise<void> {
    
  }
}
