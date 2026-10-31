import { rangeStyle } from "./rangeStyle";
import { t as tr } from "./i18n";
import { useEffect, useRef, useState } from "react";
import type { ConnectionDisplay } from "../../shared/connection-display.mjs";
import { connectionCopy } from "./connection-copy-v7";
import "./action-reasons-v7.css";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { Keyboard } from "./Keyboard";
import { Button, run } from "./primitives";
import './inline-overlays-v6.css';
import type {
  AppState,
  Command,
  Direction,
  GameState,
  GameType,
  Key,
} from "./types";

export const GAME_NAMES: Record<GameType, string> = {
  snake: "贪吃蛇",
  whack: "打地鼠",
  memory: "记忆灯序",
  pong: "双人乒乓球",
};
const MEMORY_CODES = [
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyF",
  "KeyJ",
  "KeyK",
  "KeyL",
  "Semicolon",
];
const PONG_CODES = ["KeyW", "KeyS", "ArrowUp", "ArrowDown"];
const DIRECTIONS: [Direction, string, typeof ArrowUp][] = [
  ["left", "向左", ArrowLeft],
  ["right", "向右", ArrowRight],
  ["up", "向上", ArrowUp],
  ["down", "向下", ArrowDown],
];
const RULES: Record<GameType, string> = {
  snake: "方向键移动，吃掉食物。全键盘游走，只有蛇和食物亮起。",
  whack: "按下亮起的字母键，也可点击键盘图。30 秒内尽量多命中。",
  memory: "先看灯光顺序，再按 A S D F J K L ; 原样重复。共 20 轮。",
  pong: "左手 W / S，右手 ↑ / ↓，按住移动球拍。先得 7 分获胜。",
};
const RULE_DETAILS:Record<GameType,string[]>={
  snake:[RULES.snake,'撞到边缘或自身会结束；填满可用按键即可通关。'],
  whack:[RULES.whack,'显示命中、漏失、误按与最佳成绩；到时结束。'],
  memory:[RULES.memory,'每输入正确的一键后，下一键重新计时 10 秒。','顺序不对或时间已到时结束。'],
  pong:[RULES.pong,'按住移动球拍，松开后停止。'],
};
const keyLabel = (code: string) =>
  code === "Semicolon" ? ";" : code.replace(/^Key/, "");
const playing = (game?: GameState) => game?.status === "running";
const inProgress = (game?: GameState) =>
  playing(game) || game?.status === "paused";
const finished = (game?: GameState) => game?.status === "over" || game?.status === "won";
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    Boolean(target.closest("input,select,textarea,[role='textbox'],[role='dialog']")));
const interactive=(target:EventTarget|null)=>target instanceof HTMLElement&&Boolean(target.closest("button,a,summary,[role='button'],[role='dialog']"));
export function canPressGameKey(game: GameState, code: string) {
  if (!playing(game)) return false;
  if (game.type === "whack") return /^Key[A-Z]$/.test(code);
  return (
    game.type === "memory" &&
    game.phase === "input" &&
    (game.padCodes || MEMORY_CODES).includes(code)
  );
}
function gameMessage(game: GameState | undefined, type: GameType) {
  if (game?.status === "paused") return "已暂停 · 按空格键或「继续」恢复";
  if (game?.status === "won")
    return type === "pong"
      ? game.winner === "left" ? '左方获胜，再来一局吧。' : '右方获胜，再来一局吧。'
      : type === "memory"
        ? "完成 20 轮，全部记住了！"
        : "填满键盘，通关了！";
  if (game?.status === "over")
    return type === "whack"
      ? "时间到！本局结束，再来一次吧。"
      : type === "memory"
        ? "顺序不对或时间已到，再试一次吧。"
        : type === "pong" && game.winner
          ? game.winner === 'left'?'左方获胜！':'右方获胜！'
          : "本局结束，再来一局吧。";
  if (!playing(game)) return "准备好后，开始一局。";
  if (type === "whack") return "寻找亮起的字母，准确按下。";
  if (type === "memory")
    return game?.phase === "watch"
      ? "先观察，记住闪烁顺序。"
      : game?.phase === "success"
        ? "答对了，准备下一轮。"
        : game?.phase === "error"
          ? "顺序不对。"
          : `轮到你 · 已输入 ${game?.inputIndex || 0} / ${game?.sequenceLength || 1}`;
  if (type === "pong")
    return game?.phase === "serve"
      ? `准备发球 · ${Math.max(1, Math.ceil((game.serveRemainingMs || 0) / 1000))}`
      : "接住来球，守住你的半场。";
  return "正在游戏，吃掉珊瑚色的食物。";
}

export function GamePanel({
  state,
  command,
  layout = state?.layout || [],
  display,
  onNavigateDevice,
}: {
  state: AppState | null;
  command: Command;
  layout?: Key[];
  display?: ConnectionDisplay;
  onNavigateDevice?: () => void;
}) {
  const game = state?.game;
  const type = game?.type || "snake";
  const active = playing(game),
    paused = game?.status === "paused";
  const [speed, setSpeed] = useState(game?.speed || 3);
  const [busy, setBusy] = useState(false);
  const [error,setError]=useState('');
  const [heldCodes, setHeldCodes] = useState<string[]>([]);
  const canStart = Boolean(state?.device.connected && state?.firmware?.compatible !== false && state?.device.capabilities?.perKey !== false);
  const startReason = display?.reasonId === "multipleUsb"
    ? connectionCopy({zh:"多 USB，暂不可开始游戏",en:"USB conflict; game unavailable"})
    : connectionCopy(display?.reason?.title || (display?.stateId!=="usbReady"?display?.workTitle:null))
      || connectionCopy({zh:"暂不可用",en:"Unavailable"});
  const live = useRef({ game, command, speed, canStart });
  live.current = { game, command, speed, canStart };
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const held = useRef(new Map<string, Set<string>>());
  const busyRef = useRef(false);
  const pauseRequested = useRef(false);
  const restartHeld = useRef(new Set<string>());
  const send = (body: Record<string, unknown>) => {
    const result = queue.current.then(() => live.current.command(body,{silent:true})).catch(error=>{setError(error instanceof Error?error.message:'操作未完成，请重试。');throw error;});
    queue.current = result.catch(() => undefined);
    return result;
  };
  const hold = (code: string, source: string, pressed: boolean) => {
    const sources = held.current.get(code) || new Set<string>();
    const before = sources.size > 0;
    if (pressed) {
      if (live.current.game?.type !== "pong" || !playing(live.current.game))
        return;
      sources.add(source);
    } else sources.delete(source);
    if (sources.size) held.current.set(code, sources);
    else held.current.delete(code);
    const after = sources.size > 0;
    if (before !== after) {
      setHeldCodes([...held.current.keys()]);
      run(send({ op: "gameInput", code, pressed: after }));
    }
  };
  const releaseHeld = () => {
    const codes = [...held.current.keys()];
    held.current.clear();
    setHeldCodes([]);
    for (const code of codes)
      run(send({ op: "gameInput", code, pressed: false }));
  };
  const autoPause = () => {
    restartHeld.current.clear();
    releaseHeld();
    if (playing(live.current.game) && !pauseRequested.current) {
      pauseRequested.current = true;
      run(
        send({ op: "gamePause", paused: true }).catch((error) => {
          pauseRequested.current = false;
          throw error;
        }),
      );
    }
  };
  useEffect(() => {
    if (!active) {
      pauseRequested.current = false;
      releaseHeld();
    }
  }, [active]);
  useEffect(() => {
    if (game?.speed !== undefined) setSpeed(game.speed);
  }, [type, game?.speed]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const current = live.current.game;
      if (
        editable(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (["Enter", "NumpadEnter"].includes(event.code) &&
          (finished(current) || restartHeld.current.has(event.code))) {
        if(interactive(event.target)&&!restartHeld.current.has(event.code))return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || restartHeld.current.has(event.code)) return;
        restartHeld.current.add(event.code);
        if (finished(current) && live.current.canStart)
          run(action(() => send({ op: "gameRestart", speed: live.current.speed })));
        return;
      }
      if (!inProgress(current)) return;
      if (event.code === "Space") {
        if(interactive(event.target))return;
        event.preventDefault();
        if (!event.repeat && !busyRef.current && !pauseRequested.current) {
          releaseHeld();
          if (playing(current)) pauseRequested.current = true;
          run(
            send({ op: "gamePause", paused: playing(current) }).catch(
              (error) => {
                pauseRequested.current = false;
                throw error;
              },
            ),
          );
        }
        return;
      }
      if (current?.type === "pong" && PONG_CODES.includes(event.code)) {
        event.preventDefault();
        if (!event.repeat) hold(event.code, "keyboard", true);
      } else if (
        (current?.type || "snake") === "snake" &&
        event.code.startsWith("Arrow")
      ) {
        event.preventDefault();
        if (playing(current) && !event.repeat) {
          const direction = event.code.slice(5).toLowerCase() as Direction;
          if (DIRECTIONS.some(([value]) => value === direction))
            run(send({ op: "gameInput", direction }));
        }
      } else if (current && canPressGameKey(current, event.code)) {
        event.preventDefault();
        if (!event.repeat)
          run(send({ op: "gameInput", code: event.code, pressed: true }));
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (restartHeld.current.delete(event.code)) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (held.current.get(event.code)?.has("keyboard")) {
        event.preventDefault();
        hold(event.code, "keyboard", false);
      }
    };
    const visibility = () => {
      if (document.hidden) autoPause();
    };
    const focus = (event: FocusEvent) => {
      if (editable(event.target)) releaseHeld();
    };
    // Capture Return before a focused game button can also activate on it.
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", autoPause);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", autoPause);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("focusin", focus);
      autoPause();
    };
  }, []);
  const action = async (fn: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      releaseHeld();
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const select = (gameType: GameType) =>
    action(async () => {
      if (inProgress(live.current.game)) await send({ op: "gameStop" });
      await send({ op: "gameSelect", gameType });
    });
  const pads = game?.padCodes || MEMORY_CODES;
  const descriptions: Record<GameType, string> = {
    snake: "用方向键移动，吃掉亮起的食物。",
    whack: "按下亮起的字母键，30 秒内尽量多命中。",
    memory: "记住亮灯顺序，再依次按下对应按键。",
    pong: "两人分别控制左右挡板，接住移动的球。",
  };
  const sessionStatus = active ? "正在游戏" : paused ? "已暂停" : game?.status === "won" ? "游戏通关" : finished(game) ? "游戏结束" : "尚未开始";
  const resultTitle=type==='pong'&&game?.winner?(game.winner==='left'?'左方获胜':'右方获胜'):type==='whack'?'时间到':game?.status==='won'?(type==='memory'?`挑战完成 · ${game.round??20} 轮`:'胜利'):type==='memory'?'顺序不对或时间已到':'游戏结束';
  const keyboardColors = game?.status === "idle" || !game ? Array<string>(84).fill("#000000") : state?.colors || [];
  return <div className="v5-game-layout" data-terminal={finished(game)}>
    <header className="v5-game-header">
        <label className="game-picker">
          <span>{tr("选择游戏")}</span>
          <select
            aria-label={tr("游戏类型")}
            value={type}
            disabled={busy || active || paused}
            onChange={(event) => run(select(event.target.value as GameType))}
          >
            {tr(Object.entries(GAME_NAMES).map(([value, name]) => (
              <option key={value} value={value}>
                {tr(name)}
              </option>
            )))}
          </select>
        </label>
      {inProgress(game) && <span className="v5-game-switch-hint">{tr("结束本局后可切换")}</span>}
        <div className={`game-controls ${finished(game)?"v6-game-terminal-controls":""}`}>
          <Button
            kind="primary"
            aria-describedby={!canStart?"game-start-unavailable":undefined}
            disabled={!state?.device.connected || state?.firmware?.compatible === false || state?.device.capabilities?.perKey === false}
            busy={busy}
            icon={finished(game)?undefined:active ? <Pause size={15} /> : <Play size={15} />}
            onClick={() =>
              run(
                action(() =>
                  send(
                    inProgress(game)
                      ? { op: "gamePause", paused: active }
                      : { op: "gameStart", gameType: type, speed },
                  ),
                ),
              )
            }
          >
            {tr(active ? "暂停游戏" : paused ? "继续游戏" : finished(game) ? "再来一次" : "开始游戏")}
          </Button>
          <Button
            icon={finished(game)?undefined:<Square size={14} />}
            disabled={!game || game.status === "idle" || busy}
            className={game && game.status !== "idle" ? "" : "v5-idle-end"}
            onClick={() => run(action(() => send({ op: "gameStop" })))}
          >{tr("结束游戏")}</Button>
        </div>    </header>
    {error&&<div className="inline-v6-notice inline-v6-error" role="alert">{tr(error)}</div>}
    {!canStart&&finished(game)&&<p id="game-start-unavailable" className="v7-game-action-reason" role="status">{startReason}</p>}
    <div className="v5-game-grid">
      <section className="v5-game-canvas">
        {finished(game)?<section className="v5-game-notice v6-game-result" aria-label={tr('本轮结果')} role="status"><h3 title={tr(gameMessage(game,type))}>{tr(resultTitle)}</h3><p>{tr('点击结束游戏后恢复先前灯光。')}</p></section>:!canStart?<div id="game-start-unavailable" className="v5-game-notice v7-game-unavailable" role="status"><h3>{startReason}</h3><p>{connectionCopy({zh:"游戏需要可用的 USB 逐键灯光；规则仍可查看。",en:"Games need available USB per-key lighting. You can still read the rules."})}</p></div>:<div className="v5-game-notice"><span><i className={`status-dot ${active ? "green" : ""}`} />{tr(sessionStatus)}</span><p>{tr(descriptions[type])}</p></div>}
        <Keyboard layout={layout} colors={keyboardColors}
          onGameKey={active && (type === "whack" || type === "memory") ? index => {
            const code = layout.find(key => key.index === index)?.code;
            if (code && game && canPressGameKey(game, code)) run(send({ op: "gameInput", code, pressed: true }));
          } : undefined}
          sideColor={state?.device.connected && typeof state.device.sideColor === "string" ? state.device.sideColor : undefined} />
        {!finished(game)&&<>{(active||paused)&&<p className="v5-game-feedback" role="status">{tr(gameMessage(game,type))}</p>}
        {tr(type === "whack" && (
          <p className="v5-game-feedback">{tr("命中")}{tr(game?.hits || 0)}{tr("· 错按")}{tr(game?.mistakes || 0)}{tr("· 漏掉")}{tr(" ")}
            {tr(game?.misses || 0)}
          </p>
        ))}
        {tr(type === "memory" && game?.phase === "input" && inProgress(game) && (
          <p className="v5-game-feedback">{tr(`下一键剩余 ${Math.ceil((game.remainingMs || 0) / 1000)} 秒`)}</p>
        ))}</>}
        {finished(game)&&<p className="v6-game-return-hint">{tr('按回车开始新的一局')}</p>}
        {game?.recordWarning && <div className="inline-v6-notice v6-game-record-warning" role="status"><p>{tr(game.recordWarning)}</p></div>}
        <details className="v5-game-rules inline-v6-details"><summary>{tr("游戏规则")}</summary><div className="inline-v6-detail-body"><h3>{tr(GAME_NAMES[type])}{tr(' · 完整规则')}</h3>{RULE_DETAILS[type].map(line=><p key={line}>{tr(line)}</p>)}<p>{tr('空格键：暂停 / 继续')}</p><p>{tr('离开页面会自动暂停。返回后点击继续。')}</p><p>{tr('自然结束后保留结果；点击「结束游戏」才恢复先前灯光。')}</p></div></details>
      </section>
      <aside className="v5-properties v5-game-properties">
        {!canStart&&onNavigateDevice&&<button type="button" className="text-button v7-action-link v7-game-connection-link" onClick={onNavigateDevice}>{connectionCopy({zh:"查看设备连接",en:"View connection"})}<ChevronRight size={16} aria-hidden="true"/></button>}
        <section className="v5-game-achievements"><h3>{tr("成绩")}</h3>
        <div className={`game-scores ${type === "pong" ? "pong-score" : ""}`}>
          <div>
            <span>
              {tr(type === "pong"
                ? "左方"
                : type === "memory"
                  ? "当前轮次"
                  : "本局得分")}
            </span>
            <strong>
              {tr(type === "pong"
                ? game?.leftScore || 0
                : type === "memory"
                  ? game?.round || 0
                  : String(game?.score || 0).padStart(2, "0"))}
              {tr(type === "memory" && <small> / 20</small>)}
            </strong>
          </div>
          <div>
            <span>
              {tr(type === "pong"
                ? "右方"
                : type === "whack"
                  ? "剩余时间"
                  : "最高纪录")}
            </span>
            <strong>
              {tr(type === "pong"
                ? game?.rightScore || 0
                : type === "whack"
                  ? Math.ceil(
                      (game?.status === "idle"
                        ? 30000
                        : (game?.remainingMs ?? 30000)) / 1000,
                    )
                  : game?.bestScore || 0)}
              {tr(type === "whack" && <small>{tr("秒")}</small>)}
            </strong>
          </div>
        </div>
        {finished(game)&&type==='whack'&&<p className="v6-game-result-metrics"><span>{tr('命中')} {game?.hits??0}</span><span>{tr('漏失')} {game?.misses??0}</span><span>{tr('误按')} {game?.mistakes??0}</span><span>{tr('最高纪录')} {game?.bestScore??0}</span></p>}
        </section>
        <section className="v5-game-speed">
        <label className="speed-field game-speed">{tr("游戏速度")}<span>{tr(speed)} / 10</span>
          <input
            type="range"
            aria-label={tr("游戏速度")}
            min="1"
            max="10"
            value={speed}
            style={rangeStyle(speed,1,10)}
            disabled={active || paused || busy}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
        </label>
          {inProgress(game) && <span className="v5-game-speed-help">{tr("结束本局后可调整")}</span>}
        </section>
      <section className="game-inputs"><h3>{tr("操作方法")}</h3>
        {tr(type === "snake" && (
          <div className="dpad">
            {tr(DIRECTIONS.map(([direction, label, Icon]) => (
              <button
                className={direction}
                key={direction}
                aria-label={tr(label)}
                disabled={!active}
                onClick={() => run(send({ op: "gameInput", direction }))}
              >
                <Icon size={22} />
              </button>
            )))}
          </div>
        ))}
        {tr(type === "whack" && (
          <div className="whack-guide">
            <span>{tr("当前目标")}</span>
            <strong>
              {tr((active || paused) && game?.targetCode
                ? keyLabel(game.targetCode)
                : "—")}
            </strong>
          </div>
        ))}
        {tr(type === "memory" && (
          <div className="memory-pads" aria-label={tr("记忆灯序按键")}>
            {tr(pads.map((code, index) => {
              const led = game?.padIndices?.[index];
              const lit = game?.cueIndex != null && game.cueIndex === led;
              return (
                <button
                  key={code}
                  className={lit ? "lit" : ""}
                  style={
                    lit && led !== undefined
                      ? {
                          backgroundColor: state?.colors[led],
                          borderColor: state?.colors[led],
                        }
                      : undefined
                  }
                  aria-label={tr(`记忆按键 ${keyLabel(code)}`)}
                  disabled={!active || game?.phase !== "input"}
                  onClick={() =>
                    run(send({ op: "gameInput", code, pressed: true }))
                  }
                >
                  {tr(keyLabel(code))}
                </button>
              );
            }))}
          </div>
        ))}
        {tr(type === "pong" && (
          <div className="pong-controls">
            {tr((
              [
                ["左方", ["KeyW", "KeyS"]],
                ["右方", ["ArrowUp", "ArrowDown"]],
              ] as const
            ).map(([player, codes]) => (
              <div key={player}>
                <span>{tr(player)}</span>
                {tr(codes.map((code, index) => (
                  <button
                    key={code}
                    className={heldCodes.includes(code) ? "held" : ""}
                    disabled={!active}
                    aria-label={tr(`${tr(player)} ${tr(index === 0 ? "上移" : "下移")}`)}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      hold(code, `pointer:${event.pointerId}`, true);
                    }}
                    onPointerUp={(event) =>
                      hold(code, `pointer:${event.pointerId}`, false)
                    }
                    onPointerCancel={(event) =>
                      hold(code, `pointer:${event.pointerId}`, false)
                    }
                    onLostPointerCapture={(event) =>
                      hold(code, `pointer:${event.pointerId}`, false)
                    }
                    onKeyDown={(event) => {
                      if (event.code === "Enter" && !event.repeat) {
                        event.preventDefault();
                        hold(code, `button:${code}`, true);
                      }
                    }}
                    onKeyUp={(event) => {
                      if (event.code === "Enter") {
                        event.preventDefault();
                        hold(code, `button:${code}`, false);
                      }
                    }}
                    onBlur={() => hold(code, `button:${code}`, false)}
                  >
                    {tr(index === 0 ? (
                      <ArrowUp size={15} />
                    ) : (
                      <ArrowDown size={15} />
                    ))}
                    <span>
                      {tr(code === "KeyW"
                        ? "W"
                        : code === "KeyS"
                          ? "S"
                          : index === 0
                            ? "↑"
                            : "↓")}
                    </span>
                  </button>
                )))}
              </div>
            )))}
          </div>
        ))}
        {type !== "pong" && <p className="v5-game-input-caption">{tr(type === "snake" ? "方向键移动" : type === "memory" ? "依次重复灯光提示" : "按下亮起的字母键")}</p>}
        <p className="dpad-note"><span>{tr("空格键：暂停 / 继续")}</span><small>{tr("离开页面会自动暂停。")}<br />{tr("返回后点击继续。")}</small></p>
      </section>

      </aside>
    </div>
  </div>;
}
