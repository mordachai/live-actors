import { CanvasAnimator } from "./canvas-animator.mjs";
import { TalkingHeads } from "./talking-heads.mjs";
import { VideoAnimator } from "./video-animator.mjs";

const SOCKET_EVENT = "module.live-actors";
const THROTTLE_MS = 1000 / 15;

export class SocketHandler {
  static _lastBroadcast = 0;
  // Trailing-frame counter: while going silent, keep sending a few frames so
  // remote clients ease back and settle, then suppress entirely at idle — a
  // silent client has nothing new to say 15x/sec forever.
  static _silentFramesLeft = 0;
  static _TRAILING_FRAMES = 10;

  static init() {
    game.socket.on(SOCKET_EVENT, (data) => {
      // Asset-sharing messages are keyed by token imgPath or head owner userId —
      // process them before the sender-filter so a player receives their own head assets.
      if (data.type === "tokenAssets") {
        CanvasAnimator.receiveSharedPaths(data.imgPath, data);
        return;
      }
      if (data.type === "headAssets") {
        TalkingHeads.receiveSharedHeadImages(data.userId, data);
        return;
      }
      if (data.type === "headAvatar") {
        TalkingHeads.receiveSharedAvatar(data.userId, data.hasAvatar);
        return;
      }
      if (data.type === "videoAssets") {
        VideoAnimator.receiveSharedTileImages(data.userId, data);
        return;
      }

      if (data.userId === game.user.id) return;

      if (data.type === "animState") {
        if (data.tokenId) CanvasAnimator.applyRemoteState(data.tokenId, data.state);
        TalkingHeads.update(data.userId, data.state);
        VideoAnimator.update(data.userId, data.state);
      } else if (data.type === "headPosition") {
        TalkingHeads.setPosition(data.targetUserId, data.xPct, data.yPct);
      } else if (data.type === "gmHead") {
        // GM broadcast: update GM's talking head and video tile on all player clients
        TalkingHeads.setGMAutoToken(data.tokenId);
        VideoAnimator.setGMAutoToken(data.tokenId);
      }
    });
  }

  static broadcast(state, tokenId) {
    if (state.speaking) {
      SocketHandler._silentFramesLeft = SocketHandler._TRAILING_FRAMES;
    } else if (SocketHandler._silentFramesLeft > 0) {
      SocketHandler._silentFramesLeft--;
    } else {
      return; // fully idle — remote surfaces already settled, nothing to send
    }

    const now = Date.now();
    if (now - SocketHandler._lastBroadcast < THROTTLE_MS) return;
    SocketHandler._lastBroadcast = now;
    game.socket.emit(SOCKET_EVENT, {
      type: "animState",
      userId: game.user.id,
      tokenId,
      state,
    });
  }
}
