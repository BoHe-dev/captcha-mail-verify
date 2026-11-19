// src/behavioral/analysis.ts
var CLICK_ORIGIN_WINDOW_MS = 2e3;
var TELEPORT_MAX_ELAPSED_MS = 100;
var TELEPORT_FAST_ELAPSED_MS = 20;
var TELEPORT_FAST_DISTANCE_PX = 200;
var TELEPORT_ANY_DISTANCE_PX = 600;
var MOUSE_LINEAR_WINDOW = 14;
var SCROLL_LINEAR_WINDOW = 8;
var MIN_MOUSE_FOR_LINEAR = 6;
var MIN_TOUCH_MOVES_FOR_LINEAR = 6;
var MIN_TAPS_FOR_LINEAR = 5;
var MIN_MOUSE_FOR_ZERO_DELTAS = 51;
var MIN_SCROLL_FOR_LINEAR = 4;
var MIN_KEYS_FOR_LINEAR = 5;
var MOUSE_CV_SPEED_MAX = 0.08;
var SCROLL_CV_DELTA_MAX = 0.1;
var SCROLL_CV_INTERVAL_MAX = 0.12;
var TYPING_CV_INTERVAL_MAX = 0.08;
var MOUSE_MAX_LINE_DEVIATION = 4;
var TYPING_SUPERHUMAN_INTERVAL_MS = 25;
var TAP_CV_INTERVAL_MAX = 0.08;
var TAP_SUPERHUMAN_INTERVAL_MS = 25;
function anyLinearWindow(samples, window, isLinear) {
  if (samples.length <= window) {
    return isLinear(samples);
  }
  for (let start = 0; start + window <= samples.length; start += 1) {
    if (isLinear(samples.slice(start, start + window))) {
      return true;
    }
  }
  return false;
}
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function coefficientOfVariation(values) {
  const average = mean(values);
  if (average === 0) {
    return 0;
  }
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(average);
}
function maxLineDeviation(points) {
  const start = points[0];
  let end = points[points.length - 1];
  let lineLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (lineLength === 0) {
    for (const point of points) {
      const distance = Math.hypot(point.x - start.x, point.y - start.y);
      if (distance > lineLength) {
        end = point;
        lineLength = distance;
      }
    }
  }
  if (lineLength === 0) {
    return 0;
  }
  let maxDeviation = 0;
  for (const point of points) {
    const area = Math.abs(
      (end.x - start.x) * (start.y - point.y) - (start.x - point.x) * (end.y - start.y)
    );
    maxDeviation = Math.max(maxDeviation, area / lineLength);
  }
  return maxDeviation;
}
function createSignal(id, description, triggered, weight, confidence) {
  return {
    id,
    description,
    triggered,
    weight,
    confidence,
    score: triggered ? weight : 0
  };
}
function isLinearPointerSegment(points) {
  const speeds = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const elapsed = current.t - previous.t;
    if (elapsed <= 0) {
      continue;
    }
    speeds.push(
      Math.hypot(current.x - previous.x, current.y - previous.y) / elapsed
    );
  }
  if (speeds.length < 5) {
    return false;
  }
  return coefficientOfVariation(speeds) < MOUSE_CV_SPEED_MAX && maxLineDeviation(points) < MOUSE_MAX_LINE_DEVIATION;
}
function hasLinearMouseMovement(mouseMoves) {
  if (mouseMoves.length < MIN_MOUSE_FOR_LINEAR) {
    return false;
  }
  return anyLinearWindow(mouseMoves, MOUSE_LINEAR_WINDOW, isLinearPointerSegment);
}
function hasZeroMouseMovementDeltas(mouseMoves) {
  return mouseMoves.length >= MIN_MOUSE_FOR_ZERO_DELTAS && mouseMoves.every(
    (event) => event.movementX === 0 && event.movementY === 0
  );
}
function hasTeleport(points) {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const elapsed = current.t - previous.t;
    if (elapsed > TELEPORT_MAX_ELAPSED_MS) {
      continue;
    }
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (elapsed <= TELEPORT_FAST_ELAPSED_MS && distance > TELEPORT_FAST_DISTANCE_PX) {
      return true;
    }
    if (distance > TELEPORT_ANY_DISTANCE_PX) {
      return true;
    }
  }
  return false;
}
function hasTeleportMouse(mouseMoves) {
  return hasTeleport(mouseMoves);
}
function isPointerClick(click) {
  return !(click.isTrusted && click.detail === 0);
}
function hasLeakedInputCoordinates(sample) {
  return sample.isTrusted && sample.isFullscreen === false && typeof sample.pageX === "number" && typeof sample.pageY === "number" && typeof sample.screenX === "number" && typeof sample.screenY === "number" && sample.pageX === sample.screenX && sample.pageY === sample.screenY;
}
function hasCdpInputCoordinateLeak(mouseMoves, clicks) {
  const leaked = [
    ...mouseMoves,
    ...clicks.filter(isPointerClick)
  ].filter(hasLeakedInputCoordinates);
  const distinctPositions = new Set(
    leaked.map((sample) => `${sample.pageX},${sample.pageY}`)
  );
  return distinctPositions.size >= 2;
}
function hasRecentSample(samples, at, windowMs) {
  return samples.some((sample) => sample.t >= at - windowMs && sample.t <= at);
}
function hasClickWithoutMouseMovement(mouseMoves, clicks, touches = []) {
  return clicks.some(
    (click) => isPointerClick(click) && !hasRecentSample(mouseMoves, click.t, CLICK_ORIGIN_WINDOW_MS) && !hasRecentSample(touches, click.t, CLICK_ORIGIN_WINDOW_MS)
  );
}
function hasNoMouseActivity(mouseMoves, clicks, touches = []) {
  return clicks.some(isPointerClick) && mouseMoves.length === 0 && touches.length === 0;
}
function isLinearScrollSegment(scrollEvents) {
  const deltas = scrollEvents.map((event) => Math.abs(event.deltaY));
  const intervals = [];
  for (let index = 1; index < scrollEvents.length; index += 1) {
    intervals.push(scrollEvents[index].t - scrollEvents[index - 1].t);
  }
  return coefficientOfVariation(deltas) < SCROLL_CV_DELTA_MAX && coefficientOfVariation(intervals) < SCROLL_CV_INTERVAL_MAX;
}
function hasLinearScroll(scrollEvents) {
  if (scrollEvents.length < MIN_SCROLL_FOR_LINEAR) {
    return false;
  }
  return anyLinearWindow(scrollEvents, SCROLL_LINEAR_WINDOW, isLinearScrollSegment);
}
function hasLinearTyping(keyPresses) {
  const deliberate = keyPresses.filter((key) => !key.repeat);
  if (deliberate.length < MIN_KEYS_FOR_LINEAR) {
    return false;
  }
  const intervals = [];
  for (let index = 1; index < deliberate.length; index += 1) {
    intervals.push(deliberate[index].t - deliberate[index - 1].t);
  }
  const intervalUniformity = coefficientOfVariation(intervals);
  const averageInterval = mean(intervals);
  return intervalUniformity < TYPING_CV_INTERVAL_MAX || averageInterval < TYPING_SUPERHUMAN_INTERVAL_MS;
}
function isTouchContact(touch) {
  return touch.kind !== "move";
}
function isLocatedTouch(touch) {
  return typeof touch.x === "number" && typeof touch.y === "number";
}
function splitTouchGestures(touches) {
  const gestures = [];
  let current = [];
  for (const touch of touches) {
    if (isTouchContact(touch)) {
      if (current.length > 0) {
        gestures.push(current);
      }
      current = [];
    }
    if (isLocatedTouch(touch)) {
      current.push(touch);
    }
  }
  if (current.length > 0) {
    gestures.push(current);
  }
  return gestures;
}
function hasLinearTouchMovement(touches = []) {
  return splitTouchGestures(touches).some(
    (gesture) => gesture.length >= MIN_TOUCH_MOVES_FOR_LINEAR && anyLinearWindow(gesture, MOUSE_LINEAR_WINDOW, isLinearPointerSegment)
  );
}
function hasTeleportTouch(touches = []) {
  return splitTouchGestures(touches).some(hasTeleport);
}
function hasLinearTapRhythm(touches = []) {
  const contacts = touches.filter(isTouchContact);
  if (contacts.length < MIN_TAPS_FOR_LINEAR) {
    return false;
  }
  const intervals = [];
  for (let index = 1; index < contacts.length; index += 1) {
    intervals.push(contacts[index].t - contacts[index - 1].t);
  }
  return coefficientOfVariation(intervals) < TAP_CV_INTERVAL_MAX || mean(intervals) < TAP_SUPERHUMAN_INTERVAL_MS;
}
function hasSyntheticEvents(samples) {
  const events = [
    ...samples.mouseMoves,
    ...samples.scrolls,
    ...samples.keyPresses,
    ...samples.clicks,
    ...samples.touches ?? []
  ];
  return events.some((event) => !event.isTrusted);
}
function buildBehavioralSignals(samples) {
  const touches = samples.touches ?? [];
  return [
    createSignal(
      "no-mouse-activity",
      "Clicks were recorded without any mouse or touch activity",
      hasNoMouseActivity(samples.mouseMoves, samples.clicks, touches),
      0.2,
      "low"
    ),
    createSignal(
      "click-without-mouse-movement",
      "At least one click had no recent mouse or touch activity",
      hasClickWithoutMouseMovement(samples.mouseMoves, samples.clicks, touches),
      0.35,
      "high"
    ),
    createSignal(
      "linear-mouse-movement",
      "Mouse path is unusually straight with uniform speed",
      hasLinearMouseMovement(samples.mouseMoves),
      0.25,
      "medium"
    ),
    createSignal(
      "zero-mouse-movement-deltas",
      "More than 50 mouse events all reported zero movement deltas",
      hasZeroMouseMovementDeltas(samples.mouseMoves),
      0.3,
      "medium"
    ),
    createSignal(
      "cdp-input-coordinate-leak",
      "Repeated trusted pointer events exposed identical page and screen coordinates",
      hasCdpInputCoordinateLeak(samples.mouseMoves, samples.clicks),
      0.2,
      "low"
    ),
    createSignal(
      "teleport-mouse",
      "Mouse position jumped implausibly between events",
      hasTeleportMouse(samples.mouseMoves),
      0.4,
      "high"
    ),
    createSignal(
      "linear-touch-movement",
      "Swipe path is unusually straight with uniform speed",
      hasLinearTouchMovement(touches),
      0.25,
      "medium"
    ),
    createSignal(
      "teleport-touch",
      "Touch point jumped implausibly mid-gesture",
      hasTeleportTouch(touches),
      0.4,
      "high"
    ),
    createSignal(
      "linear-tap-rhythm",
      "Tap intervals are robotic or superhuman",
      hasLinearTapRhythm(touches),
      0.3,
      "medium"
    ),
    createSignal(
      "linear-scroll",
      "Scroll deltas and timing are overly uniform",
      hasLinearScroll(samples.scrolls),
      0.3,
      "medium"
    ),
    createSignal(
      "linear-typing",
      "Typing intervals are robotic or superhuman",
      hasLinearTyping(samples.keyPresses),
      0.35,
      "high"
    ),
    createSignal(
      "synthetic-events",
      "Observed pointer or keyboard events were not trusted",
      hasSyntheticEvents(samples),
      0.5,
      "high"
    )
  ];
}

// src/behavioral/scoring.ts
function aggregateSuspicionScore(signals) {
  const triggered = signals.filter((signal) => signal.triggered);
  if (triggered.length === 0) {
    return 0;
  }
  let score = 1;
  for (const signal of triggered) {
    score *= 1 - signal.weight;
  }
  return 1 - score;
}
function resolveConfidence(signals, sampleCounts, suspicionScore) {
  const totalSamples = sampleCounts.mouseMoves + sampleCounts.scrolls + sampleCounts.keyPresses + sampleCounts.clicks + sampleCounts.touches;
  const triggeredHigh = signals.filter(
    (signal) => signal.triggered && signal.confidence === "high"
  ).length;
  if (totalSamples < 5) {
    return "low";
  }
  if (triggeredHigh >= 2 || suspicionScore >= 0.75) {
    return "high";
  }
  if (suspicionScore >= 0.4 || totalSamples >= 20) {
    return "medium";
  }
  return "low";
}
function countSyntheticEvents(samples) {
  return [
    ...samples.mouseMoves,
    ...samples.scrolls,
    ...samples.keyPresses,
    ...samples.clicks,
    ...samples.touches ?? []
  ].filter((event) => !event.isTrusted).length;
}
function analyzeBehavioralSamples(samples, scoreThreshold = 0.55) {
  const signals = buildBehavioralSignals(samples);
  const suspicionScore = aggregateSuspicionScore(signals);
  const sampleCounts = {
    mouseMoves: samples.mouseMoves.length,
    scrolls: samples.scrolls.length,
    keyPresses: samples.keyPresses.length,
    clicks: samples.clicks.length,
    touches: samples.touches?.length ?? 0,
    syntheticEvents: countSyntheticEvents(samples)
  };
  const confidence = resolveConfidence(signals, sampleCounts, suspicionScore);
  return {
    suspicionScore,
    confidence,
    signals,
    sampleCounts,
    observationMs: samples.observationMs,
    isLegitClient: suspicionScore < scoreThreshold
  };
}

// src/behavioral/index.ts
var DEFAULT_MIN_OBSERVATION_MS = 3e3;
var DEFAULT_SCORE_THRESHOLD = 0.55;
var DEFAULT_POLL_INTERVAL_MS = 1e3;
var DEFAULT_SAMPLE_WINDOW_MS = 6e4;
function pruneStream(stream, cutoff) {
  let firstFresh = 0;
  while (firstFresh < stream.length && stream[firstFresh].t < cutoff) {
    firstFresh += 1;
  }
  if (firstFresh > 0) {
    stream.splice(0, firstFresh);
  }
}
function createEmptySamples(observationMs = 0) {
  return {
    mouseMoves: [],
    scrolls: [],
    keyPresses: [],
    clicks: [],
    touches: [],
    observationMs
  };
}
function createBehavioralClientDetector(options = {}) {
  const context = options.context ?? globalThis;
  const minObservationMs = options.minObservationMs ?? DEFAULT_MIN_OBSERVATION_MS;
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sampleWindowMs = options.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS;
  let samples = createEmptySamples();
  let startedAt;
  let listeners = [];
  let pollTimer;
  let isActive = false;
  let observeTimer;
  let observeResolve;
  const pruneRetainedSamples = (now = Date.now()) => {
    if (!Number.isFinite(sampleWindowMs)) {
      return;
    }
    const cutoff = now - sampleWindowMs;
    pruneStream(samples.mouseMoves, cutoff);
    pruneStream(samples.scrolls, cutoff);
    pruneStream(samples.keyPresses, cutoff);
    pruneStream(samples.clicks, cutoff);
    pruneStream(samples.touches, cutoff);
  };
  const record = (stream, sample) => {
    stream.push(sample);
    pruneRetainedSamples(sample.t);
  };
  const getObservationMs = () => {
    if (startedAt === void 0) {
      return samples.observationMs;
    }
    return samples.observationMs + (Date.now() - startedAt);
  };
  const evaluate = () => {
    if (isActive) {
      pruneRetainedSamples();
    }
    return analyzeBehavioralSamples(
      {
        ...samples,
        observationMs: getObservationMs()
      },
      scoreThreshold
    );
  };
  const addListener = (target, type, handler) => {
    target.addEventListener(type, handler, { passive: true });
    listeners.push({ target, type, handler });
  };
  const onMouseMove = (event) => {
    const mouseEvent = event;
    record(samples.mouseMoves, {
      x: mouseEvent.clientX,
      y: mouseEvent.clientY,
      movementX: mouseEvent.movementX,
      movementY: mouseEvent.movementY,
      pageX: mouseEvent.pageX,
      pageY: mouseEvent.pageY,
      screenX: mouseEvent.screenX,
      screenY: mouseEvent.screenY,
      isFullscreen: context.outerHeight - context.innerHeight <= 1,
      t: Date.now(),
      isTrusted: mouseEvent.isTrusted
    });
  };
  const onWheel = (event) => {
    const wheelEvent = event;
    record(samples.scrolls, {
      deltaY: wheelEvent.deltaY,
      t: Date.now(),
      isTrusted: wheelEvent.isTrusted
    });
  };
  const onKeyDown = (event) => {
    const keyboardEvent = event;
    record(samples.keyPresses, {
      t: Date.now(),
      isTrusted: keyboardEvent.isTrusted,
      repeat: keyboardEvent.repeat
    });
  };
  const onClick = (event) => {
    const mouseEvent = event;
    record(samples.clicks, {
      x: mouseEvent.clientX,
      y: mouseEvent.clientY,
      t: Date.now(),
      isTrusted: mouseEvent.isTrusted,
      detail: mouseEvent.detail,
      pageX: mouseEvent.pageX,
      pageY: mouseEvent.pageY,
      screenX: mouseEvent.screenX,
      screenY: mouseEvent.screenY,
      isFullscreen: context.outerHeight - context.innerHeight <= 1
    });
  };
  const recordTouch = (event, kind) => {
    const touchEvent = event;
    const point = touchEvent.touches?.length === 1 ? touchEvent.changedTouches?.[0] : void 0;
    record(samples.touches, {
      t: Date.now(),
      isTrusted: touchEvent.isTrusted,
      kind,
      ...point ? { x: point.clientX, y: point.clientY } : {}
    });
  };
  const onTouchStart = (event) => {
    recordTouch(event, "start");
  };
  const onTouchMove = (event) => {
    recordTouch(event, "move");
  };
  const start = () => {
    if (isActive) {
      return;
    }
    isActive = true;
    startedAt = Date.now();
    addListener(context, "mousemove", onMouseMove);
    addListener(context, "wheel", onWheel);
    addListener(context, "keydown", onKeyDown);
    addListener(context, "click", onClick);
    addListener(context, "touchstart", onTouchStart);
    addListener(context, "touchmove", onTouchMove);
    if (options.onUpdate) {
      pollTimer = setInterval(() => {
        options.onUpdate?.(evaluate());
      }, pollIntervalMs);
    }
  };
  const settleObservation = () => {
    if (!observeResolve) {
      return;
    }
    const resolve = observeResolve;
    observeResolve = void 0;
    if (observeTimer !== void 0) {
      clearTimeout(observeTimer);
      observeTimer = void 0;
    }
    resolve(evaluate());
  };
  const stop = () => {
    if (!isActive) {
      return;
    }
    pruneRetainedSamples();
    isActive = false;
    samples.observationMs = getObservationMs();
    startedAt = void 0;
    for (const listener of listeners) {
      listener.target.removeEventListener(listener.type, listener.handler);
    }
    listeners = [];
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = void 0;
    }
    settleObservation();
  };
  const reset = () => {
    stop();
    samples = createEmptySamples();
    startedAt = void 0;
  };
  const getResult = () => evaluate();
  const observe = (durationMs = minObservationMs) => {
    if (observeResolve) {
      return Promise.reject(
        new Error(
          "createBehavioralClientDetector: an observation is already in progress"
        )
      );
    }
    start();
    return new Promise((resolve) => {
      observeResolve = resolve;
      observeTimer = setTimeout(stop, durationMs);
    });
  };
  return {
    start,
    stop,
    reset,
    getResult,
    observe
  };
}

// src/automation.ts
function createAutomationAssessment(isAutomated, kind, confidence, evidence, alternatives = []) {
  return { isAutomated, kind, confidence, evidence, alternatives };
}

// src/webgpu.ts
function isChromiumBrowser(context) {
  const userAgent = context.navigator.userAgent;
  return userAgent.includes("Chrome/") || userAgent.includes("Edg/");
}
async function checkShaderF16Support(context) {
  if (!isChromiumBrowser(context)) {
    return true;
  }
  const gpu = context.navigator.gpu;
  if (!gpu) {
    return false;
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return false;
    }
    return adapter.features.has("shader-f16");
  } catch {
    return false;
  }
}

// src/checks.ts
var SOFTWARE_RENDERER_PATTERNS = [
  /swiftshader/i,
  /llvmpipe/i,
  /mesa offscreen/i,
  /software renderer/i
];
var GPU_PLATFORM_RULES = [
  { renderer: /Direct3D|\bD3D(?:9|11|12)\b/i, platform: /Windows|Win64|WOW64/i },
  {
    renderer: /Metal Renderer|Apple GPU|Apple M\d/i,
    platform: /Macintosh|Mac OS X|iPhone|iPad|iPod/i
  },
  { renderer: /Adreno|Mali-|PowerVR Rogue/i, platform: /Android/i }
];
var ALLOWED_DEVICE_MEMORY = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
var CANVAS_CHANNEL_TOLERANCE = 8;
var ALLOWED_COLOR_DEPTHS = [8, 15, 16, 24, 30, 32, 48];
var GREASE_BRAND_PATTERN = /not[^a-z0-9]*a[^a-z0-9]*brand/i;
var NAVIGATOR_ACCESSOR_PROPERTIES = [
  "webdriver",
  "hardwareConcurrency",
  "languages",
  "plugins"
];
var PLAYWRIGHT_KEY_PATTERNS = [
  /^__playwright(?:__binding__)?$/,
  /^__pw(?:InitScripts|_manual)$/
];
var PUPPETEER_KEY_PATTERNS = [
  /^__puppeteer_evaluation_script__$/
];
var CHROMEDRIVER_KEY_PATTERNS = [
  /^cdc_[a-zA-Z0-9]{10,}_(?:Array|JSON|Object|Promise|Proxy|Symbol|Window)$/,
  /^\$cdc_[a-zA-Z0-9]{10,}_$/,
  /^\$chrome_asyncScriptInfo$/,
  /^_WEBDRIVER_ELEM_CACHE$/
];
var LEGACY_AUTOMATION_KEY_PATTERNS = [
  /^_Selenium_IDE_Recorder$/,
  /^_selenium$/,
  /^calledSelenium$/,
  /^webdriver$/,
  /^__webdriverFunc$/,
  /^__lastWatir(?:Alert|Confirm|Prompt)$/,
  /^ChromeDriverw$/,
  /^awesomium$/,
  /^RunPerfTest$/,
  /^CefSharp$/,
  /^fmget_targets$/,
  /^geb$/,
  /^nightmare$/,
  /^__phantomas$/,
  /^wdioElectron$/
];
var LEGACY_DOCUMENT_KEY_PATTERNS = [
  /^driver-evaluate$/,
  /^webdriver-evaluate$/,
  /^webdriverCommand$/,
  /^webdriver-evaluate-response$/,
  /^webdriver$/,
  /^_Selenium_IDE_Recorder$/,
  /^_selenium$/,
  /^calledSelenium$/,
  /^__webdriverFunc$/,
  /^__lastWatir(?:Alert|Confirm|Prompt)$/,
  /^ChromeDriverw$/,
  /^__selenium_evaluate$/,
  /^selenium-evaluate$/,
  /^__selenium_unwrapped$/,
  /^__webdriver_script_(?:fn|func|function)$/,
  /^__driver_evaluate$/,
  /^__webdriver_evaluate$/,
  /^__fxdriver_evaluate$/,
  /^__driver_unwrapped$/,
  /^__webdriver_unwrapped$/,
  /^__fxdriver_unwrapped$/,
  /^__\$webdriverAsyncExecutor$/
];
var AUTOMATION_STACK_PATTERN = /(?:pptr:|UtilityScript\.)/i;
var PLAYWRIGHT_BINDING_SOURCE_PATTERN = /exposeBindingHandle supports a single argument/;
var PUPPETEER_BINDING_SOURCE_PATTERN = /This is the Puppeteer binding/;
var SANNYSOFT_DOCUMENT_CACHE_KEY_PATTERN = /\$[a-z]dc_/;
function hasMatchingKey(target, patterns) {
  for (const key of Object.getOwnPropertyNames(target)) {
    for (const pattern of patterns) {
      if (pattern.test(key)) {
        return true;
      }
    }
  }
  return false;
}
function hasMatchingTruthyKey(target, patterns) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (patterns.some((pattern) => pattern.test(key)) && Boolean(getPropertySafely(target, key))) {
      return true;
    }
  }
  return false;
}
function getPropertySafely(target, property) {
  try {
    return Reflect.get(target, property);
  } catch {
    return void 0;
  }
}
function hasFunctionSourceMarker(context, pattern) {
  let toString;
  try {
    toString = context.Function?.prototype.toString ?? Function.prototype.toString;
  } catch {
    return false;
  }
  if (typeof toString !== "function") {
    return false;
  }
  for (const key of Object.getOwnPropertyNames(context)) {
    const value = Object.getOwnPropertyDescriptor(context, key)?.value;
    if (typeof value === "function") {
      try {
        if (pattern.test(toString.call(value))) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}
function hasInstalledExposedFunction(target) {
  return Object.getOwnPropertyNames(target).some((key) => {
    const value = Object.getOwnPropertyDescriptor(target, key)?.value;
    if (typeof value !== "function") {
      return false;
    }
    try {
      return value.__installed === true;
    } catch {
      return false;
    }
  });
}
function hasPrefixedFunction(target, pattern) {
  return Object.getOwnPropertyNames(target).some(
    (key) => pattern.test(key) && typeof Object.getOwnPropertyDescriptor(target, key)?.value === "function"
  );
}
function hasAutomationDocumentAttribute(context) {
  try {
    const root = context.document.documentElement;
    return Boolean(
      root?.hasAttribute && ["selenium", "webdriver", "driver"].some(
        (attribute) => root.hasAttribute(attribute)
      )
    );
  } catch {
    return false;
  }
}
function isSeleniumDocumentArtifacts(context) {
  return hasMatchingTruthyKey(context.document, LEGACY_DOCUMENT_KEY_PATTERNS);
}
function hasSannysoftDocumentCache(context) {
  for (const key in context.document) {
    if (!SANNYSOFT_DOCUMENT_CACHE_KEY_PATTERN.test(key)) {
      continue;
    }
    const value = getPropertySafely(context.document, key);
    if ((typeof value === "object" && value !== null || typeof value === "function") && Boolean(getPropertySafely(value, "cache_"))) {
      return true;
    }
  }
  return false;
}
function hasRenamedChromeDriverGlobals(context) {
  const constructors = [
    ["Array", getPropertySafely(context, "Array")],
    ["Promise", getPropertySafely(context, "Promise")],
    ["Symbol", getPropertySafely(context, "Symbol")]
  ];
  if (constructors.some(([, constructor]) => constructor === void 0)) {
    return false;
  }
  const aliases = /* @__PURE__ */ new Set();
  for (const key of Object.getOwnPropertyNames(context)) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    for (const [canonicalName, constructor] of constructors) {
      if (key !== canonicalName && descriptor.value === constructor) {
        aliases.add(constructor);
      }
    }
  }
  return aliases.size === constructors.length;
}
function hasRenamedChromeDriverDocumentCache(context) {
  for (const key of Object.getOwnPropertyNames(context.document)) {
    const descriptor = Object.getOwnPropertyDescriptor(context.document, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    const value = descriptor.value;
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      continue;
    }
    try {
      const cache = Object.getOwnPropertyDescriptor(value, "cache_");
      const prototype = Object.getPrototypeOf(value);
      if (!cache || !("value" in cache) || cache.value === void 0 || !prototype) {
        continue;
      }
      const actualNames = Object.getOwnPropertyNames(prototype).sort();
      const expectedNames = [
        "isNodeReachable_",
        "retrieveItem",
        "storeItem"
      ];
      if (actualNames.length === expectedNames.length && actualNames.every((name, index) => name === expectedNames[index])) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
function isMissingChromeObject(context) {
  if (!isChromiumBrowser(context)) {
    return false;
  }
  return getPropertySafely(context, "chrome") === void 0;
}
function hasWebGlContext(context) {
  try {
    return Boolean(context.document.createElement("canvas").getContext("webgl"));
  } catch {
    return false;
  }
}
function readWebGlIdentity(context) {
  try {
    const canvas = context.document.createElement("canvas");
    const gl = canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl");
    if (!gl) {
      return null;
    }
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (!debugInfo) {
      return null;
    }
    const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    if (typeof renderer !== "string") {
      return null;
    }
    const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
    return { vendor: typeof vendor === "string" ? vendor : "", renderer };
  } catch {
    return null;
  }
}
function isSoftwareRenderer(context) {
  const identity = readWebGlIdentity(context);
  if (!identity) {
    return false;
  }
  return SOFTWARE_RENDERER_PATTERNS.some(
    (pattern) => pattern.test(identity.renderer)
  );
}
function isGpuPlatformMismatch(context) {
  const identity = readWebGlIdentity(context);
  if (!identity) {
    return false;
  }
  const userAgent = context.navigator.userAgent;
  const gpu = `${identity.vendor} ${identity.renderer}`;
  return GPU_PLATFORM_RULES.some(
    (rule) => rule.renderer.test(gpu) && !rule.platform.test(userAgent)
  );
}
function isSuspiciousWindowDimensions(context) {
  if (context.outerWidth === 0 && context.outerHeight === 0) {
    return true;
  }
  const noBrowserChrome = context.outerWidth === context.innerWidth && context.outerHeight === context.innerHeight;
  const zeroScreenOffset = context.screenX === 0 && context.screenY === 0 && context.outerWidth > 800;
  return noBrowserChrome && zeroScreenOffset;
}
function isEmptyPlugins(context) {
  if (!isChromiumBrowser(context)) {
    return false;
  }
  if (/Mobi|Android/i.test(context.navigator.userAgent)) {
    return false;
  }
  return context.navigator.plugins.length === 0;
}
function isLegacyAutomationArtifacts(context) {
  const processValue = getPropertySafely(context, "process");
  const process = typeof processValue === "object" && processValue !== null || typeof processValue === "function" ? processValue : void 0;
  const versions = process ? getPropertySafely(process, "versions") : void 0;
  const hasElectronVersion = (typeof versions === "object" && versions !== null || typeof versions === "function") && getPropertySafely(versions, "electron") !== void 0;
  const isElectron = process && getPropertySafely(process, "type") === "renderer" || hasElectronVersion || /(?:Electron|SlimerJS)/i.test(
    `${context.navigator.userAgent} ${context.navigator.appVersion ?? ""}`
  );
  let isSequentum = false;
  try {
    isSequentum = /Sequentum/i.test(String(context.external ?? ""));
  } catch {
    isSequentum = false;
  }
  return isElectron || isSequentum || hasMatchingTruthyKey(context, LEGACY_AUTOMATION_KEY_PATTERNS) || isSeleniumDocumentArtifacts(context) || hasInstalledExposedFunction(context) || hasAutomationDocumentAttribute(context);
}
function isAutomationArtifacts(context) {
  return isPlaywright(context) || isPuppeteer(context) || isChromeDriver(context) || isLegacyAutomationArtifacts(context);
}
function isPlaywright(context) {
  return hasMatchingKey(context, PLAYWRIGHT_KEY_PATTERNS) || hasFunctionSourceMarker(context, PLAYWRIGHT_BINDING_SOURCE_PATTERN);
}
function isPuppeteer(context) {
  return hasMatchingKey(context, PUPPETEER_KEY_PATTERNS) || hasPrefixedFunction(context, /^puppeteer_/) || hasFunctionSourceMarker(context, PUPPETEER_BINDING_SOURCE_PATTERN);
}
function isChromeDriver(context) {
  return hasMatchingKey(context, CHROMEDRIVER_KEY_PATTERNS) || hasMatchingKey(context.document, CHROMEDRIVER_KEY_PATTERNS) || hasSannysoftDocumentCache(context) || hasRenamedChromeDriverGlobals(context) || hasRenamedChromeDriverDocumentCache(context);
}
function isUserAgentDataMismatch(context) {
  const data = context.navigator.userAgentData;
  if (!data) {
    return false;
  }
  const userAgent = context.navigator.userAgent;
  const chromeMajor = userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1];
  const brandMajors = data.brands.filter((brand) => /^(?:Chromium|Google Chrome)$/i.test(brand.brand)).map((brand) => brand.version.match(/^\d+/)?.[0]).filter((version) => version !== void 0);
  if (chromeMajor && brandMajors.length > 0 && brandMajors.some((version) => version !== chromeMajor)) {
    return true;
  }
  const uaIsMobile = /Mobi/i.test(userAgent);
  if (typeof data.mobile === "boolean" && data.mobile !== uaIsMobile) {
    return true;
  }
  if (data.platform) {
    if (/Android/i.test(userAgent) && !/Android/i.test(data.platform)) {
      return true;
    }
    if (/CrOS/i.test(userAgent) && !/Chrome OS/i.test(data.platform)) {
      return true;
    }
    if (/Linux/i.test(userAgent) && !/Android|CrOS/i.test(userAgent) && !/Linux/i.test(data.platform)) {
      return true;
    }
    if (/Windows/i.test(userAgent) && !/Windows/i.test(data.platform)) {
      return true;
    }
    if (/(Macintosh|Mac OS X)/i.test(userAgent) && !/macOS/i.test(data.platform)) {
      return true;
    }
  }
  return false;
}
function isLanguageInconsistent(context) {
  const { language, languages } = context.navigator;
  if (!languages) {
    return false;
  }
  if (languages.length === 0) {
    return true;
  }
  if (!language) {
    return false;
  }
  return languages[0]?.toLowerCase() !== language.toLowerCase();
}
function isPluginMimeTypeInconsistent(context) {
  if (!context.navigator.plugins || !context.navigator.mimeTypes) {
    return false;
  }
  const pluginCount = context.navigator.plugins.length;
  const mimeTypeCount = context.navigator.mimeTypes.length;
  return pluginCount === 0 !== (mimeTypeCount === 0);
}
function findPropertyDescriptor(value, property) {
  const visited = /* @__PURE__ */ new Set();
  let depth = 0;
  for (let target = value; target !== null && depth < 32; target = Object.getPrototypeOf(target)) {
    if (visited.has(target)) {
      return void 0;
    }
    visited.add(target);
    depth += 1;
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor) {
      return descriptor;
    }
  }
  return void 0;
}
function isNativeFunction(value, toString) {
  if (typeof value !== "function") {
    return false;
  }
  try {
    return /\{\s*\[native code\]\s*\}/.test(toString.call(value));
  } catch {
    return false;
  }
}
function isNativeFunctionTampered(context) {
  const functionConstructor = getPropertySafely(context, "Function");
  if (!functionConstructor) {
    return false;
  }
  let bind;
  let toString;
  try {
    ({ bind, toString } = functionConstructor.prototype);
  } catch {
    return true;
  }
  if (typeof toString !== "function") {
    return true;
  }
  const functionToString = toString;
  if (!isNativeFunction(toString, functionToString) || !isNativeFunction(bind, functionToString)) {
    return true;
  }
  const isNativeNavigator = Object.prototype.toString.call(context.navigator) === "[object Navigator]";
  for (const property of NAVIGATOR_ACCESSOR_PROPERTIES) {
    const descriptor = findPropertyDescriptor(context.navigator, property);
    if (!descriptor) {
      continue;
    }
    if (!descriptor.get) {
      if (isNativeNavigator) {
        return true;
      }
      continue;
    }
    if (!isNativeFunction(descriptor.get, functionToString)) {
      return true;
    }
  }
  return false;
}
function platformContradictsUserAgent(platform, userAgent) {
  if (/Android/i.test(userAgent)) {
    return !/Android|Linux/i.test(platform);
  }
  if (/CrOS/i.test(userAgent)) {
    return !/CrOS|Linux/i.test(platform);
  }
  if (/Windows/i.test(userAgent)) {
    return !/Win/i.test(platform);
  }
  if (/(?:iPhone|iPad|iPod)/i.test(userAgent)) {
    return !/(?:iPhone|iPad|iPod|Mac)/i.test(platform);
  }
  if (/(?:Macintosh|Mac OS X)/i.test(userAgent)) {
    return !/Mac/i.test(platform);
  }
  if (/Linux/i.test(userAgent)) {
    return !/Linux/i.test(platform);
  }
  return false;
}
function isNavigatorIdentityInconsistent(context) {
  const navigator = context.navigator;
  const userAgent = navigator.userAgent;
  const vendor = navigator.vendor;
  if (/\b(?:Chrome|Chromium|Edg)\//i.test(userAgent) && vendor !== void 0 && vendor !== "Google Inc." || /\bFirefox\//i.test(userAgent) && Boolean(vendor) || /\bVersion\/[^ ]+.*Safari\//i.test(userAgent) && vendor !== void 0 && vendor !== "Apple Computer, Inc.") {
    return true;
  }
  if (navigator.platform && platformContradictsUserAgent(navigator.platform, userAgent)) {
    return true;
  }
  if (navigator.productSub !== void 0 && /\b(?:Chrome|Chromium|Edg|Version\/[^ ]+.*Safari)\//i.test(userAgent) && navigator.productSub !== "20030107") {
    return true;
  }
  const oscpu = navigator.oscpu;
  if (typeof oscpu === "string" && oscpu) {
    if (!/\bFirefox\//i.test(userAgent)) {
      return true;
    }
    if (platformContradictsUserAgent(oscpu, userAgent)) {
      return true;
    }
  }
  return /(?:Mobi|Android|iPhone|iPad)/i.test(userAgent) && navigator.maxTouchPoints !== void 0 && navigator.maxTouchPoints === 0;
}
function isMissingGreaseBrand(context) {
  const brands = context.navigator.userAgentData?.brands;
  if (!brands || brands.length === 0) {
    return false;
  }
  return !brands.some((brand) => GREASE_BRAND_PATTERN.test(brand.brand));
}
function isPluginArrayInconsistent(context) {
  const { plugins, mimeTypes } = context.navigator;
  if (!plugins || !mimeTypes) {
    return false;
  }
  if (context.PluginArray && !(plugins instanceof context.PluginArray)) {
    return true;
  }
  if (context.MimeTypeArray && !(mimeTypes instanceof context.MimeTypeArray)) {
    return true;
  }
  if (context.Plugin) {
    for (let index = 0; index < plugins.length; index += 1) {
      if (!(plugins[index] instanceof context.Plugin)) {
        return true;
      }
    }
  }
  try {
    const firstPlugin = plugins[0];
    if (firstPlugin && firstPlugin.toString() !== "[object Plugin]") {
      return true;
    }
  } catch {
    return true;
  }
  if (context.MimeType) {
    for (let index = 0; index < mimeTypes.length; index += 1) {
      if (!(mimeTypes[index] instanceof context.MimeType)) {
        return true;
      }
    }
  }
  if (plugins.length > 0 && typeof plugins.item === "function") {
    try {
      if (plugins.item(4294967296) !== plugins[0]) {
        return true;
      }
      const mimeType = plugins[0]?.[0];
      if (mimeType && mimeType.enabledPlugin !== plugins[0]) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}
function getOsFamily(userAgent) {
  if (!userAgent) {
    return null;
  }
  if (/Android/i.test(userAgent)) {
    return "android";
  }
  if (/(?:iPhone|iPad|iPod)/i.test(userAgent)) {
    return "ios";
  }
  if (/CrOS/i.test(userAgent)) {
    return "cros";
  }
  if (/Windows|Win64|Win32|WOW64/i.test(userAgent)) {
    return "windows";
  }
  if (/(?:Macintosh|Mac OS X|MacIntel)/i.test(userAgent)) {
    return "macos";
  }
  if (/Linux|X11/i.test(userAgent)) {
    return "linux";
  }
  return null;
}
function contradicts(main, other) {
  return main !== null && other !== null && main !== other;
}
function hasRealmPersonaMismatch(main, other) {
  return contradicts(getOsFamily(main.userAgent), getOsFamily(other.userAgent)) || contradicts(getOsFamily(main.platform), getOsFamily(other.platform));
}
function isIframeInconsistent(context) {
  const parent = context.document.documentElement ?? context.document.body;
  if (!parent?.appendChild) {
    return false;
  }
  const iframe = context.document.createElement("iframe");
  let inconsistent = false;
  try {
    iframe.style.display = "none";
    parent.appendChild(iframe);
    const frame = iframe.contentWindow;
    if (frame) {
      const main = context.navigator;
      const child = frame.navigator;
      const isParentRealm = frame === context || child === main;
      const hasWebDriverDrift = Boolean(main.webdriver) !== Boolean(child.webdriver);
      inconsistent = isParentRealm || hasWebDriverDrift;
    }
  } catch {
    inconsistent = false;
  }
  iframe.remove();
  return inconsistent;
}
function isErrorStackAutomation(context) {
  if (!context.Error) {
    return false;
  }
  try {
    return AUTOMATION_STACK_PATTERN.test(new context.Error().stack ?? "");
  } catch {
    return false;
  }
}
function isDefaultAutomationViewport(context) {
  const dimensions = [
    [context.screen.width, context.screen.height],
    [context.innerWidth, context.innerHeight]
  ];
  return dimensions.some(
    ([width, height]) => width === 800 && height === 600 || width === 1280 && height === 720
  );
}
function isSuspiciousHardware(context) {
  const cores = context.navigator.hardwareConcurrency;
  const memory = context.navigator.deviceMemory;
  if (typeof memory === "number" && !ALLOWED_DEVICE_MEMORY.includes(memory)) {
    return true;
  }
  if (typeof cores !== "number") {
    return false;
  }
  return !Number.isInteger(cores) || cores < 1 || cores > 128 || cores > 32 && typeof memory === "number" && memory <= 2;
}
function isZeroConnectionRtt(context) {
  const connection = context.navigator.connection;
  return !/Android/i.test(context.navigator.userAgent) && connection?.rtt === 0;
}
function isCanvasTampered(context) {
  try {
    const canvas = context.document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) {
      return false;
    }
    canvasContext.clearRect(0, 0, 1, 1);
    canvasContext.fillStyle = "#112233";
    canvasContext.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = canvasContext.getImageData(0, 0, 1, 1).data;
    const expected = [17, 34, 51, 255];
    return [red, green, blue, alpha].some(
      (channel, index) => typeof channel !== "number" || Math.abs(channel - expected[index]) > CANVAS_CHANNEL_TOLERANCE
    );
  } catch {
    return false;
  }
}
var CANVAS_PROBE_WIDTH = 64;
var CANVAS_PROBE_HEIGHT = 24;
function renderCanvasProbe(context) {
  try {
    const canvas = context.document.createElement("canvas");
    canvas.width = CANVAS_PROBE_WIDTH;
    canvas.height = CANVAS_PROBE_HEIGHT;
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) {
      return null;
    }
    canvasContext.textBaseline = "top";
    canvasContext.font = "14px 'Arial'";
    canvasContext.fillStyle = "#f60";
    canvasContext.fillRect(0, 0, 44, 12);
    canvasContext.fillStyle = "#069";
    canvasContext.fillText("bot,signal", 2, 2);
    canvasContext.fillStyle = "rgba(102, 204, 0, 0.7)";
    canvasContext.fillText("bot,signal", 4, 6);
    const { data } = canvasContext.getImageData(
      0,
      0,
      CANVAS_PROBE_WIDTH,
      CANVAS_PROBE_HEIGHT
    );
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}
function isCanvasNoiseInjected(context) {
  const first = renderCanvasProbe(context);
  if (first === null) {
    return false;
  }
  const second = renderCanvasProbe(context);
  if (second === null || second.length !== first.length) {
    return false;
  }
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) {
      return true;
    }
  }
  return false;
}
function isTimezoneInconsistent(context) {
  const intl = context.Intl ?? Intl;
  const dateConstructor = context.Date ?? Date;
  try {
    const zone = intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) {
      return false;
    }
    const now = new dateConstructor();
    const reportedOffset = -now.getTimezoneOffset();
    if (!Number.isFinite(reportedOffset)) {
      return false;
    }
    const parts = new intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(now);
    const field = (type) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = dateConstructor.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour"),
      field("minute"),
      field("second")
    );
    if (!Number.isFinite(asUtc)) {
      return false;
    }
    const zoneOffset = Math.round(
      (asUtc - Math.floor(now.getTime() / 1e3) * 1e3) / 6e4
    );
    return Math.abs(zoneOffset - reportedOffset) > 1;
  } catch {
    return false;
  }
}
function getClaimedEngine(userAgent) {
  if (/(?:iPhone|iPad|iPod)/i.test(userAgent)) {
    return "webkit";
  }
  if (/\b(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\//i.test(userAgent)) {
    return "chromium";
  }
  if (/\bFirefox\//i.test(userAgent)) {
    return "gecko";
  }
  if (/\bVersion\/[^ ]+.*Safari\//i.test(userAgent)) {
    return "webkit";
  }
  return null;
}
function isEngineInconsistent(context) {
  const engine = getClaimedEngine(context.navigator.userAgent);
  if (!engine) {
    return false;
  }
  const hasSpiderMonkeyGlobals = getPropertySafely(context, "InternalError") !== void 0 || getPropertySafely(context, "mozInnerScreenX") !== void 0;
  if (hasSpiderMonkeyGlobals !== (engine === "gecko")) {
    return true;
  }
  const evaluate = getPropertySafely(context, "eval");
  if (typeof evaluate !== "function") {
    return false;
  }
  let evalLength;
  try {
    evalLength = evaluate.toString().length;
  } catch {
    return false;
  }
  if (evalLength === 33) {
    return engine !== "chromium";
  }
  if (evalLength === 37) {
    return engine === "chromium";
  }
  return false;
}
function isMediaQueryInconsistent(context) {
  const matchMedia = context.matchMedia;
  if (typeof matchMedia !== "function") {
    return false;
  }
  const matches = (query) => {
    try {
      return matchMedia.call(context, query).matches;
    } catch {
      return null;
    }
  };
  if (matches("(min-resolution: 0dppx)") !== true) {
    return false;
  }
  const ratio = context.devicePixelRatio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) {
    return false;
  }
  const tolerance = Math.max(ratio * 0.02, 0.02);
  return matches(`(min-resolution: ${ratio - tolerance}dppx)`) === false || matches(`(max-resolution: ${ratio + tolerance}dppx)`) === false;
}
function isScreenGeometryInconsistent(context) {
  const screen = context.screen;
  const { width, height, availWidth, availHeight, colorDepth, pixelDepth } = screen;
  if (typeof width !== "number" || typeof height !== "number") {
    return false;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return true;
  }
  if (typeof availWidth === "number" && availWidth > width) {
    return true;
  }
  if (typeof availHeight === "number" && availHeight > height) {
    return true;
  }
  if (typeof colorDepth === "number") {
    if (!ALLOWED_COLOR_DEPTHS.includes(colorDepth)) {
      return true;
    }
    if (typeof pixelDepth === "number" && pixelDepth !== colorDepth) {
      return true;
    }
  }
  const ratio = context.devicePixelRatio;
  return typeof ratio === "number" && (ratio <= 0 || ratio > 8);
}
function isMissingProprietaryCodecs(context) {
  if (!isChromiumBrowser(context)) {
    return false;
  }
  try {
    const video = context.document.createElement("video");
    if (typeof video.canPlayType !== "function") {
      return false;
    }
    return video.canPlayType('video/mp4; codecs="avc1.42E01E"') === "";
  } catch {
    return false;
  }
}
function isSuspiciousWebDriverDescriptor(context) {
  const navigator = context.navigator;
  if (Object.prototype.hasOwnProperty.call(navigator, "webdriver")) {
    return true;
  }
  if (!isChromiumBrowser(context)) {
    return false;
  }
  const isNativeNavigator = Object.prototype.toString.call(navigator) === "[object Navigator]";
  for (let prototype = Object.getPrototypeOf(navigator); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "webdriver");
    if (descriptor) {
      return isNativeNavigator && (typeof descriptor.get !== "function" || descriptor.set !== void 0 || descriptor.enumerable !== true || descriptor.configurable !== true);
    }
  }
  return true;
}

// src/asyncChecks.ts
var scheduleDetectorTask = globalThis.setTimeout.bind(globalThis);
var cancelDetectorTask = globalThis.clearTimeout.bind(globalThis);
var APPLE_ONLY_VOICES = /* @__PURE__ */ new Set([
  "Alex",
  "Daniel",
  "Fiona",
  "Fred",
  "Karen",
  "Kyoko",
  "Lekha",
  "Moira",
  "Rishi",
  "Samantha",
  "Sin-ji",
  "Tessa",
  "Ting-Ting",
  "Victoria",
  "Yuna"
]);
var VOICE_LIST_TIMEOUT_MS = 300;
function bestEffort(action) {
  try {
    action();
  } catch {
  }
}
var EMPTY_WORKER_CHECKS = {
  isWorkerInconsistent: null,
  isWebDriverInWorker: null,
  isWorkerWebGLInconsistent: null,
  isCdpDetectedInWorker: null
};
var WORKER_SOURCE = `
  const error = new Error();
  let cdpDetected = false;
  Object.defineProperty(error, "stack", {
    get() {
      cdpDetected = true;
      return "";
    },
  });
  console.debug(error);
  let webGlVendor = null;
  let webGlRenderer = null;
  try {
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(1, 1);
      const gl = canvas.getContext("webgl");
      const debugInfo = gl && gl.getExtension("WEBGL_debug_renderer_info");
      if (gl && debugInfo) {
        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        webGlVendor = typeof vendor === "string" ? vendor : null;
        webGlRenderer = typeof renderer === "string" ? renderer : null;
      }
    }
  } catch {}
  setTimeout(() => {
    self.postMessage({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      webdriver: navigator.webdriver,
      webGlVendor,
      webGlRenderer,
      cdpDetected,
    });
  }, 0);
`;
function platformContradictsUserAgent2(platform, userAgent) {
  if (/Android/i.test(userAgent)) {
    return !/Android/i.test(platform);
  }
  if (/CrOS/i.test(userAgent)) {
    return !/Chrome OS/i.test(platform);
  }
  if (/Windows/i.test(userAgent)) {
    return !/Windows/i.test(platform);
  }
  if (/(?:Macintosh|Mac OS X)/i.test(userAgent)) {
    return !/macOS/i.test(platform);
  }
  if (/Linux/i.test(userAgent)) {
    return !/Linux/i.test(platform);
  }
  return false;
}
async function checkCdpRuntime(context) {
  if (!isChromiumBrowser(context) || typeof context.console?.debug !== "function") {
    return null;
  }
  let accessed = false;
  const error = new Error();
  Object.defineProperty(error, "stack", {
    get() {
      accessed = true;
      return "";
    }
  });
  try {
    context.console.debug(error);
    await new Promise((resolve) => {
      scheduleDetectorTask(resolve, 0);
    });
    return accessed;
  } catch {
    return null;
  }
}
async function checkMediaDevices(context) {
  const mediaDevices = context.navigator.mediaDevices;
  if (!isChromiumBrowser(context) || /Mobi|Android/i.test(context.navigator.userAgent) || typeof mediaDevices?.enumerateDevices !== "function") {
    return null;
  }
  try {
    const devices = await mediaDevices.enumerateDevices();
    return devices.length === 0;
  } catch {
    return null;
  }
}
async function readVoices(synthesis) {
  const voices = synthesis.getVoices();
  if (voices.length > 0 || typeof synthesis.addEventListener !== "function") {
    return voices;
  }
  await new Promise((resolve) => {
    const deadline = scheduleDetectorTask(resolve, VOICE_LIST_TIMEOUT_MS);
    synthesis.addEventListener(
      "voiceschanged",
      () => {
        bestEffort(() => cancelDetectorTask(deadline));
        resolve();
      },
      { once: true }
    );
  });
  return synthesis.getVoices();
}
async function checkSpeechVoices(context) {
  const synthesis = context.speechSynthesis;
  if (!synthesis || typeof synthesis.getVoices !== "function") {
    return null;
  }
  let voices;
  try {
    voices = await readVoices(synthesis);
  } catch {
    return null;
  }
  if (voices.length === 0) {
    return null;
  }
  const names = voices.map((voice) => voice.name);
  const userAgent = context.navigator.userAgent;
  if (!/(?:Macintosh|Mac OS X|iPhone|iPad|iPod)/i.test(userAgent)) {
    const appleVoices = names.filter((name) => APPLE_ONLY_VOICES.has(name));
    if (appleVoices.length >= 2) {
      return true;
    }
  }
  const claimsGoogleChrome = context.navigator.userAgentData?.brands.some(
    (brand) => /^Google Chrome$/i.test(brand.brand)
  );
  return Boolean(
    claimsGoogleChrome && /(?:Windows|Macintosh|Mac OS X)/i.test(userAgent) && !names.some((name) => name.startsWith("Google "))
  );
}
async function checkNotificationPermissionConsistency(context) {
  const permissions = context.navigator.permissions;
  const notification = context.Notification;
  if (!permissions?.query || !notification) {
    return null;
  }
  try {
    const permission = await permissions.query({ name: "notifications" });
    const expectedState = notification.permission === "default" ? "prompt" : notification.permission;
    return permission.state !== expectedState;
  } catch {
    return null;
  }
}
async function checkHighEntropyUserAgentData(context) {
  const data = context.navigator.userAgentData;
  const getHighEntropyValues = data?.getHighEntropyValues;
  if (!data || !getHighEntropyValues) {
    return null;
  }
  try {
    const values = await getHighEntropyValues.call(data, [
      "fullVersionList",
      "platform",
      "platformVersion",
      "architecture",
      "bitness",
      "model",
      "formFactors"
    ]);
    const userAgent = context.navigator.userAgent;
    const uaMajor = userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1];
    const fullVersionMajors = values.fullVersionList?.filter((brand) => /^(?:Chromium|Google Chrome)$/i.test(brand.brand)).map((brand) => brand.version.match(/^\d+/)?.[0]).filter((version) => version !== void 0);
    if (uaMajor && fullVersionMajors && fullVersionMajors.length > 0 && fullVersionMajors.some((version) => version !== uaMajor)) {
      return true;
    }
    if (typeof values.mobile === "boolean" && values.mobile !== /Mobi/i.test(userAgent)) {
      return true;
    }
    return Boolean(
      values.platform && platformContradictsUserAgent2(values.platform, userAgent)
    );
  } catch {
    return null;
  }
}
function compareWorkerSnapshot(context, snapshot) {
  return hasRealmPersonaMismatch(context.navigator, snapshot);
}
function compareWorkerWebGl(context, snapshot) {
  const main = readWebGlIdentity(context);
  if (!main?.vendor || !main.renderer || typeof snapshot.webGlVendor !== "string" || !snapshot.webGlVendor || typeof snapshot.webGlRenderer !== "string" || !snapshot.webGlRenderer) {
    return null;
  }
  return snapshot.webGlVendor !== main.vendor || snapshot.webGlRenderer !== main.renderer;
}
async function checkWorkerConsistency(context) {
  let workerConstructor;
  let blobConstructor;
  let urlConstructor;
  let createObjectUrl;
  let revokeObjectUrl;
  try {
    workerConstructor = context.Worker;
    blobConstructor = context.Blob;
    urlConstructor = context.URL;
    createObjectUrl = urlConstructor?.createObjectURL;
    revokeObjectUrl = urlConstructor?.revokeObjectURL;
  } catch {
    return EMPTY_WORKER_CHECKS;
  }
  if (!workerConstructor || !blobConstructor || !urlConstructor || typeof createObjectUrl !== "function") {
    return EMPTY_WORKER_CHECKS;
  }
  let objectUrl;
  try {
    const blob = new blobConstructor([WORKER_SOURCE], {
      type: "text/javascript"
    });
    objectUrl = createObjectUrl.call(urlConstructor, blob);
  } catch {
    return EMPTY_WORKER_CHECKS;
  }
  let worker;
  try {
    worker = new workerConstructor(objectUrl);
  } catch {
    bestEffort(() => {
      revokeObjectUrl?.call(urlConstructor, objectUrl);
    });
    return EMPTY_WORKER_CHECKS;
  }
  return new Promise((resolve) => {
    let settled = false;
    let deadline;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      bestEffort(() => cancelDetectorTask(deadline));
      bestEffort(() => {
        worker.onmessage = null;
      });
      bestEffort(() => {
        worker.onerror = null;
      });
      bestEffort(() => {
        worker.terminate();
      });
      bestEffort(() => {
        revokeObjectUrl?.call(urlConstructor, objectUrl);
      });
      resolve(result);
    };
    try {
      deadline = scheduleDetectorTask(
        () => finish(EMPTY_WORKER_CHECKS),
        500
      );
      worker.onmessage = (event) => {
        try {
          const snapshot = event.data;
          if (!snapshot || typeof snapshot !== "object") {
            finish(EMPTY_WORKER_CHECKS);
            return;
          }
          finish({
            isWorkerInconsistent: compareWorkerSnapshot(context, snapshot),
            isWebDriverInWorker: snapshot.webdriver === true ? true : snapshot.webdriver === false ? false : null,
            isWorkerWebGLInconsistent: compareWorkerWebGl(context, snapshot),
            isCdpDetectedInWorker: isChromiumBrowser(context) && typeof snapshot.cdpDetected === "boolean" ? snapshot.cdpDetected : null
          });
        } catch {
          finish(EMPTY_WORKER_CHECKS);
        }
      };
      worker.onerror = () => finish(EMPTY_WORKER_CHECKS);
    } catch {
      finish(EMPTY_WORKER_CHECKS);
    }
  });
}

// src/userAgent.ts
var SCRIPTING_USER_AGENT_PATTERNS = [
  {
    kind: "curl",
    pattern: /(?:^|[\s;(])curl\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "python",
    pattern: /(?:^|[\s;(])(?:python-requests|urllib3|python-urllib|aiohttp|httpx)\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "go",
    pattern: /(?:^|[\s;(])Go-http-client\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "java",
    pattern: /(?:^|[\s;(])(?:Java|Java-http-client|Apache-HttpClient|okhttp)\/\d+(?:[._]\d+)*(?=$|[\s;)])/i
  }
];
var BOT_USER_AGENT_PATTERNS = [
  {
    kind: "crawler",
    pattern: /(?:^|[\s;(])(?:Googlebot(?:-[A-Za-z]+)?|Google-InspectionTool|GoogleOther(?:-[A-Za-z]+)?|bingbot|Baiduspider|YandexBot|DuckDuckBot|Applebot|PetalBot|AhrefsBot|SemrushBot|GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Amazonbot|Bytespider|CCBot|PerplexityBot|YouBot|facebookexternalhit|Twitterbot)\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "crawler",
    pattern: /(?:^|[\s;(])(?:AdsBot-Google(?:-Mobile)?|GoogleOther(?:-[A-Za-z]+)?)(?=$|[\s;)])/i
  },
  {
    kind: "http-client",
    pattern: /(?:^|[\s;(])Wget\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "browser-automation",
    pattern: /(?:^|[\s;(])HeadlessChrome\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "lightpanda",
    pattern: /(?:^|[\s;(])Lightpanda\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "playwright",
    pattern: /(?:^|[\s;(])Playwright\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "puppeteer",
    pattern: /(?:^|[\s;(])Puppeteer\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "selenium",
    pattern: /(?:^|[\s;(])Selenium\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  },
  {
    kind: "phantomjs",
    pattern: /(?:^|[\s;(])(?:PhantomJS|SlimerJS)\/\d+(?:\.\d+)*(?=$|[\s;)])/i
  }
];
function getScriptingUserAgentKind(userAgent) {
  return SCRIPTING_USER_AGENT_PATTERNS.find(({ pattern }) => pattern.test(userAgent))?.kind ?? null;
}
function isBotUserAgent(userAgent) {
  return getBotUserAgentKind(userAgent) !== null;
}
function getBotUserAgentKind(userAgent) {
  if (!userAgent) {
    return null;
  }
  return BOT_USER_AGENT_PATTERNS.find(({ pattern }) => pattern.test(userAgent))?.kind ?? null;
}

// src/detectInstantClient.ts
var DEFAULT_SCORE_THRESHOLD2 = 0.5;
var MODERN_BROWSER_FLOORS = {
  chrome: 121,
  firefox: 128,
  safari: 16.4
};
var INSTANT_SIGNAL_SPECS = [
  { id: "isWebDriver", description: "navigator.webdriver is set", weight: 1, confidence: "high" },
  { id: "isPlaywright", description: "Playwright bindings or init-script artifacts present", weight: 1, confidence: "high" },
  { id: "isPuppeteer", description: "Puppeteer bindings or evaluation artifacts present", weight: 1, confidence: "high" },
  { id: "isChromeDriver", description: "ChromeDriver or WebDriver cache artifacts present", weight: 1, confidence: "high" },
  { id: "isAutomationArtifacts", description: "Framework, legacy automation, or embedded-runtime artifacts present", weight: 0.35, confidence: "low" },
  { id: "isSelenium", description: "Selenium markers on document", weight: 1, confidence: "high" },
  { id: "isPhantomJS", description: "PhantomJS globals present", weight: 1, confidence: "high" },
  { id: "isNightmare", description: "Nightmare.js marker present", weight: 1, confidence: "high" },
  { id: "isDomAutomation", description: "DOM automation controller globals present", weight: 1, confidence: "high" },
  { id: "isHeadless", description: "Lightpanda/HeadlessChrome UA, HeadlessChrome appVersion/Client Hints, or webdriver flag", weight: 0.9, confidence: "high" },
  { id: "isSuspiciousWebDriverDescriptor", description: "navigator.webdriver descriptor was tampered with", weight: 0.9, confidence: "high" },
  { id: "isSuspiciousResolution", description: "Screen smaller than any real device", weight: 0.7, confidence: "medium" },
  { id: "isUserAgentValid", description: "User agent is malformed or identifies a known bot, scripting, or automation client", weight: 0.7, confidence: "high", triggerWhenFalse: true },
  { id: "isSoftwareRenderer", description: "WebGL uses a software renderer (SwiftShader/llvmpipe)", weight: 0.6, confidence: "medium" },
  { id: "isUserAgentDataMismatch", description: "User-Agent conflicts with Client Hints", weight: 0.65, confidence: "high" },
  { id: "isNativeFunctionTampered", description: "Native browser functions or Navigator getters were patched", weight: 0.8, confidence: "high" },
  { id: "isNavigatorIdentityInconsistent", description: "Navigator vendor/platform/product/touch claims conflict with the User-Agent", weight: 0.65, confidence: "high" },
  { id: "isPluginArrayInconsistent", description: "Plugin or MIME-type arrays have non-native prototypes", weight: 0.65, confidence: "high" },
  { id: "isIframeInconsistent", description: "A fresh iframe hands back the page's own realm, or disagrees about navigator.webdriver", weight: 0.8, confidence: "high" },
  { id: "isErrorStackAutomation", description: "Error stack contains an automation source marker", weight: 0.85, confidence: "high" },
  { id: "isEngineInconsistent", description: "JavaScript engine identity conflicts with the browser the User-Agent claims", weight: 0.8, confidence: "high" },
  { id: "isGpuPlatformMismatch", description: "WebGL renderer names a graphics backend the claimed platform cannot run", weight: 0.6, confidence: "high" },
  { id: "isMediaQueryInconsistent", description: "The CSS resolution query contradicts the reported devicePixelRatio", weight: 0.5, confidence: "medium" },
  { id: "isLanguageInconsistent", description: "Navigator language values are inconsistent", weight: 0.45, confidence: "medium" },
  { id: "isScreenGeometryInconsistent", description: "Screen reports impossible geometry or colour depth", weight: 0.45, confidence: "medium" },
  { id: "isTimezoneInconsistent", description: "The resolved IANA time zone contradicts the UTC offset Date reports", weight: 0.5, confidence: "medium" },
  { id: "isMissingProprietaryCodecs", description: "Chromium build without H.264 support (unbranded automation build)", weight: 0.4, confidence: "low" },
  { id: "isMissingGreaseBrand", description: "Client Hints brands omit the GREASE entry every Chromium build injects", weight: 0.4, confidence: "medium" },
  { id: "isCanvasNoiseInjected", description: "Two identical canvas renders read back differently", weight: 0.35, confidence: "medium" },
  { id: "isPluginMimeTypeInconsistent", description: "Plugin and MIME-type arrays are inconsistent", weight: 0.45, confidence: "medium" },
  { id: "isMissingChromeObject", description: "Chromium user agent without window.chrome", weight: 0.35, confidence: "low" },
  { id: "isWebGLSupported", description: "No WebGL context available", weight: 0.35, confidence: "low", triggerWhenFalse: true },
  { id: "isSuspiciousWindowDimensions", description: "Window has zero outer size or no browser chrome at the screen origin", weight: 0.3, confidence: "low" },
  { id: "isModern", description: "Browser build is below the modern baseline", weight: 0.3, confidence: "low", triggerWhenFalse: true },
  { id: "isEmptyPlugins", description: "Desktop Chromium with an empty plugin list", weight: 0.25, confidence: "low" },
  { id: "isSuspiciousHardware", description: "CPU and device-memory values are implausible or contradictory", weight: 0.3, confidence: "low" },
  { id: "isZeroConnectionRtt", description: "Network Information reports a zero RTT outside Android", weight: 0.2, confidence: "low" },
  { id: "isDefaultAutomationViewport", description: "Screen or viewport matches a common automation default", weight: 0.2, confidence: "low" },
  { id: "isCanvasTampered", description: "A deterministic canvas pixel was modified on readback", weight: 0.2, confidence: "low" }
];
var INSTANT_ASYNC_SIGNAL_SPECS = [
  { id: "isShaderF16Supported", description: "WebGPU shader-f16 feature is missing on Chromium", weight: 0.3, confidence: "low", triggerWhenFalse: true },
  { id: "isCdpDetected", description: "Chrome DevTools Protocol serialized an Error object", weight: 0.25, confidence: "medium" },
  { id: "isNotificationPermissionInconsistent", description: "Notification and Permissions API states contradict", weight: 0.55, confidence: "high" },
  { id: "isHighEntropyUserAgentDataMismatch", description: "High-entropy Client Hints conflict with the User-Agent", weight: 0.65, confidence: "high" },
  { id: "isWorkerInconsistent", description: "The worker realm names a different operating system than the page", weight: 0.8, confidence: "high" },
  { id: "isWebDriverInWorker", description: "Worker navigator exposes webdriver", weight: 0.9, confidence: "high" },
  { id: "isWorkerWebGLInconsistent", description: "Worker and page WebGL identities disagree", weight: 0.35, confidence: "medium" },
  { id: "isCdpDetectedInWorker", description: "Chrome DevTools Protocol serialized an Error inside a worker", weight: 0.25, confidence: "medium" },
  { id: "isMissingMediaDevices", description: "Desktop Chromium enumerated no audio or video devices", weight: 0.3, confidence: "low" },
  { id: "isVoiceListInconsistent", description: "Installed speech voices contradict the claimed platform or browser brand", weight: 0.35, confidence: "medium" }
];
function parseBrowserVersion(userAgent, pattern) {
  const match = userAgent.match(pattern);
  return parseFloat(match?.[1] ?? "0");
}
function hasTruthyProperty(target, properties) {
  return properties.some(
    (property) => Boolean(getPropertySafely(target, property))
  );
}
function detectSync(context) {
  const isWebDriver = Boolean(
    getPropertySafely(context.navigator, "webdriver")
  );
  const isPhantomJS = hasTruthyProperty(context, ["callPhantom", "_phantom"]);
  const isNightmare = Boolean(getPropertySafely(context, "__nightmare"));
  const isSelenium = hasTruthyProperty(context, [
    "_Selenium_IDE_Recorder",
    "_selenium",
    "calledSelenium",
    "callSelenium"
  ]) || isSeleniumDocumentArtifacts(context);
  const isDomAutomation = hasTruthyProperty(context, [
    "domAutomation",
    "domAutomationController"
  ]);
  const isPlaywrightClient = isPlaywright(context);
  const isPuppeteerClient = isPuppeteer(context);
  const isChromeDriverClient = isChromeDriver(context);
  const hasAutomationArtifacts = isPlaywrightClient || isPuppeteerClient || isChromeDriverClient || isLegacyAutomationArtifacts(context);
  const userAgent = context.navigator.userAgent;
  const isHeadless = Boolean(
    isWebDriver || userAgent.includes("Headless") || context.navigator.appVersion?.includes("Headless") || getBotUserAgentKind(userAgent) === "lightpanda" || context.navigator.userAgentData?.brands.some(
      (brand) => /Headless/i.test(brand.brand)
    )
  );
  const isSuspiciousResolution = context.screen.width < 136 || context.screen.height < 170;
  const isUserAgentValid = context.navigator.userAgent.startsWith("Mozilla/5.0 (") && getScriptingUserAgentKind(context.navigator.userAgent) === null && !isBotUserAgent(context.navigator.userAgent);
  const isWebGLSupported = hasWebGlContext(context);
  const isModern = userAgent.includes("Chrome/") && parseBrowserVersion(userAgent, /Chrome\/(\d+\.\d+)/) >= MODERN_BROWSER_FLOORS.chrome || userAgent.includes("Firefox/") && parseBrowserVersion(userAgent, /Firefox\/(\d+\.\d+)/) >= MODERN_BROWSER_FLOORS.firefox || userAgent.includes("Safari") && !userAgent.includes("Chrome") && parseBrowserVersion(userAgent, /Version\/(\d+\.\d+)/) >= MODERN_BROWSER_FLOORS.safari;
  return {
    isWebDriver,
    isPhantomJS,
    isNightmare,
    isSelenium,
    isDomAutomation,
    isHeadless,
    isSuspiciousResolution,
    isUserAgentValid,
    isWebGLSupported,
    isModern,
    isMissingChromeObject: isMissingChromeObject(context),
    isSoftwareRenderer: isSoftwareRenderer(context),
    isSuspiciousWindowDimensions: isSuspiciousWindowDimensions(context),
    isEmptyPlugins: isEmptyPlugins(context),
    isAutomationArtifacts: hasAutomationArtifacts,
    isPlaywright: isPlaywrightClient,
    isPuppeteer: isPuppeteerClient,
    isChromeDriver: isChromeDriverClient,
    isSuspiciousWebDriverDescriptor: isSuspiciousWebDriverDescriptor(context),
    isUserAgentDataMismatch: isUserAgentDataMismatch(context),
    isLanguageInconsistent: isLanguageInconsistent(context),
    isPluginMimeTypeInconsistent: isPluginMimeTypeInconsistent(context),
    isNativeFunctionTampered: isNativeFunctionTampered(context),
    isNavigatorIdentityInconsistent: isNavigatorIdentityInconsistent(context),
    isPluginArrayInconsistent: isPluginArrayInconsistent(context),
    isIframeInconsistent: isIframeInconsistent(context),
    isErrorStackAutomation: isErrorStackAutomation(context),
    isDefaultAutomationViewport: isDefaultAutomationViewport(context),
    isSuspiciousHardware: isSuspiciousHardware(context),
    isZeroConnectionRtt: isZeroConnectionRtt(context),
    isCanvasTampered: isCanvasTampered(context),
    isEngineInconsistent: isEngineInconsistent(context),
    isGpuPlatformMismatch: isGpuPlatformMismatch(context),
    isMediaQueryInconsistent: isMediaQueryInconsistent(context),
    isScreenGeometryInconsistent: isScreenGeometryInconsistent(context),
    isMissingProprietaryCodecs: isMissingProprietaryCodecs(context),
    isCanvasNoiseInjected: isCanvasNoiseInjected(context),
    isTimezoneInconsistent: isTimezoneInconsistent(context),
    isMissingGreaseBrand: isMissingGreaseBrand(context)
  };
}
function createSignal2(id, description, triggered, weight, confidence) {
  return { id, description, triggered, weight, confidence, score: triggered ? weight : 0 };
}
function buildInstantSignals(checks, asyncChecks) {
  const resolvedAsyncChecks = typeof asyncChecks === "boolean" ? { isShaderF16Supported: asyncChecks } : asyncChecks;
  const signals = INSTANT_SIGNAL_SPECS.map((spec) => {
    const value = checks[spec.id] ?? false;
    const triggered = spec.triggerWhenFalse ? !value : value;
    return createSignal2(spec.id, spec.description, triggered, spec.weight, spec.confidence);
  });
  let hasCdpSignal = false;
  for (const spec of INSTANT_ASYNC_SIGNAL_SPECS) {
    const isCdpSignal = spec.id === "isCdpDetected" || spec.id === "isCdpDetectedInWorker";
    if (isCdpSignal && hasCdpSignal) {
      continue;
    }
    const value = resolvedAsyncChecks?.[spec.id];
    if (value === null || value === void 0) {
      continue;
    }
    const triggered = spec.triggerWhenFalse ? !value : value;
    if (triggered) {
      if (isCdpSignal) {
        hasCdpSignal = true;
      }
      signals.push(
        createSignal2(
          spec.id,
          spec.description,
          true,
          spec.weight,
          spec.confidence
        )
      );
    }
  }
  return signals;
}
function classifyInstantAutomation(checks, isChromium, confidence, userAgent, signals) {
  const exactUaKind = getScriptingUserAgentKind(userAgent);
  if (checks.isPlaywright) {
    return createAutomationAssessment(true, "playwright", "medium", [
      "Playwright binding or init-script artifact present"
    ]);
  }
  if (checks.isPuppeteer) {
    return createAutomationAssessment(true, "puppeteer", "medium", [
      "Puppeteer evaluation artifact present"
    ]);
  }
  if (checks.isSelenium) {
    return createAutomationAssessment(true, "selenium", "medium", [
      "Selenium document artifact present"
    ]);
  }
  if (checks.isChromeDriver) {
    return createAutomationAssessment(
      true,
      "browser-automation",
      "medium",
      ["ChromeDriver artifact present"],
      ["selenium"]
    );
  }
  if (checks.isPhantomJS) {
    return createAutomationAssessment(true, "phantomjs", "medium", [
      "PhantomJS global present"
    ]);
  }
  if (checks.isNightmare) {
    return createAutomationAssessment(true, "nightmare", "medium", [
      "Nightmare.js global present"
    ]);
  }
  if (exactUaKind) {
    return createAutomationAssessment(
      true,
      exactUaKind,
      "medium",
      [`User-Agent claims ${exactUaKind}`],
      isChromium ? ["browser-automation"] : []
    );
  }
  const botUaKind = getBotUserAgentKind(userAgent);
  if (botUaKind) {
    const automationKind = botUaKind === "crawler" || botUaKind === "http-client" ? "unknown" : botUaKind;
    const alternatives = botUaKind === "browser-automation" && isChromium ? ["patchright", "playwright", "puppeteer", "selenium"] : [];
    return createAutomationAssessment(
      true,
      automationKind,
      "high",
      [`User-Agent claims ${botUaKind}`],
      [...alternatives]
    );
  }
  const attributionSignalIds = /* @__PURE__ */ new Set([
    "isWebDriver",
    "isWebDriverInWorker",
    "isDomAutomation",
    "isHeadless",
    "isSuspiciousWebDriverDescriptor"
  ]);
  const evidence = signals.filter(
    (signal) => signal.triggered && attributionSignalIds.has(signal.id)
  ).map((signal) => signal.description);
  const isBrowserAutomationPattern = checks.isWebDriver || signals.some(
    (signal) => signal.id === "isWebDriverInWorker" && signal.triggered
  ) || checks.isDomAutomation || checks.isHeadless || checks.isSuspiciousWebDriverDescriptor;
  if (isBrowserAutomationPattern) {
    const alternatives = checks.isHeadless && !checks.isWebDriver && !checks.isDomAutomation && !checks.isSuspiciousWebDriverDescriptor && isChromium ? ["patchright", "playwright", "puppeteer", "selenium"] : ["playwright", "puppeteer", "selenium"];
    return createAutomationAssessment(
      true,
      "browser-automation",
      confidence,
      evidence,
      [...alternatives]
    );
  }
  return createAutomationAssessment(false, "unknown", "low", []);
}
function aggregateInstantSuspicionScore(signals) {
  let keep = 1;
  for (const signal of signals) {
    if (signal.triggered) {
      keep *= 1 - signal.weight;
    }
  }
  return 1 - keep;
}
function resolveInstantConfidence(signals, suspicionScore) {
  const triggeredHigh = signals.filter(
    (signal) => signal.triggered && signal.confidence === "high"
  ).length;
  if (triggeredHigh >= 1 || suspicionScore >= 0.7) {
    return "high";
  }
  if (suspicionScore >= 0.35) {
    return "medium";
  }
  return "low";
}
function assemble(checks, isChromium, scoreThreshold, userAgent, asyncChecks) {
  const signals = buildInstantSignals(checks, asyncChecks);
  const suspicionScore = aggregateInstantSuspicionScore(signals);
  const confidence = resolveInstantConfidence(signals, suspicionScore);
  const isLegitClient = suspicionScore < scoreThreshold;
  return {
    ...checks,
    isChromium,
    suspicionScore,
    confidence,
    signals,
    isLegitClient,
    automation: classifyInstantAutomation(
      checks,
      isChromium,
      confidence,
      userAgent,
      signals
    )
  };
}
function detectInstantClient(context, options = {}) {
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD2;
  const checks = detectSync(context);
  const isChromium = isChromiumBrowser(context);
  return assemble(
    checks,
    isChromium,
    scoreThreshold,
    context.navigator.userAgent
  );
}
async function detectInstantClientAsync(context, options = {}) {
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD2;
  const checks = detectSync(context);
  const isChromium = isChromiumBrowser(context);
  const [
    shaderF16Supported,
    isCdpDetected,
    isNotificationPermissionInconsistent,
    isHighEntropyUserAgentDataMismatch,
    isMissingMediaDevices,
    isVoiceListInconsistent,
    workerChecks
  ] = await Promise.all([
    isChromium ? checkShaderF16Support(context) : Promise.resolve(null),
    checkCdpRuntime(context),
    checkNotificationPermissionConsistency(context),
    checkHighEntropyUserAgentData(context),
    checkMediaDevices(context),
    checkSpeechVoices(context),
    checkWorkerConsistency(context)
  ]);
  const asyncChecks = {
    isShaderF16Supported: shaderF16Supported,
    isCdpDetected,
    isNotificationPermissionInconsistent,
    isHighEntropyUserAgentDataMismatch,
    isMissingMediaDevices,
    isVoiceListInconsistent,
    ...workerChecks
  };
  return {
    ...assemble(
      checks,
      isChromium,
      scoreThreshold,
      context.navigator.userAgent,
      asyncChecks
    ),
    ...asyncChecks
  };
}
function isHuman(context, options = {}) {
  return detectInstantClient(context, options).isLegitClient;
}
async function isHumanAsync(context, options = {}) {
  const result = await detectInstantClientAsync(context, options);
  return result.isLegitClient;
}

// src/version.ts
var VERSION = "2.0.18";

export { VERSION, aggregateInstantSuspicionScore, aggregateSuspicionScore, analyzeBehavioralSamples, buildBehavioralSignals, buildInstantSignals, checkCdpRuntime, checkHighEntropyUserAgentData, checkMediaDevices, checkNotificationPermissionConsistency, checkShaderF16Support, checkSpeechVoices, checkWorkerConsistency, createBehavioralClientDetector, detectInstantClient, detectInstantClientAsync, hasCdpInputCoordinateLeak, hasClickWithoutMouseMovement, hasLinearMouseMovement, hasLinearScroll, hasLinearTapRhythm, hasLinearTouchMovement, hasLinearTyping, hasNoMouseActivity, hasSyntheticEvents, hasTeleportMouse, hasTeleportTouch, hasZeroMouseMovementDeltas, isAutomationArtifacts, isBotUserAgent, isCanvasNoiseInjected, isCanvasTampered, isChromeDriver, isChromiumBrowser, isDefaultAutomationViewport, isEmptyPlugins, isEngineInconsistent, isErrorStackAutomation, isGpuPlatformMismatch, isHuman, isHumanAsync, isIframeInconsistent, isLanguageInconsistent, isMediaQueryInconsistent, isMissingChromeObject, isMissingGreaseBrand, isMissingProprietaryCodecs, isNativeFunctionTampered, isNavigatorIdentityInconsistent, isPlaywright, isPluginArrayInconsistent, isPluginMimeTypeInconsistent, isPuppeteer, isScreenGeometryInconsistent, isSoftwareRenderer, isSuspiciousHardware, isSuspiciousWebDriverDescriptor, isSuspiciousWindowDimensions, isTimezoneInconsistent, isUserAgentDataMismatch, isZeroConnectionRtt, resolveConfidence, resolveInstantConfidence };
//# sourceMappingURL=browser.js.map
//# sourceMappingURL=browser.js.map