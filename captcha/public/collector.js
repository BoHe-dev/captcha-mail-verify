const SIGNAL_CATEGORIES = [
    'mouse',
    'clicks',
    'keystrokes',
    'scroll',
    'touch',
    'sensors',
    'eventOrder',
    'engagement',
];

const DEFAULT_LIMITS = {
    mouse: 500,
    clicks: 50,
    keys: 100,
    scroll: 200,
    touch: 300,
    sensors: 200,
    events: 500,
};

function createCollector(options = {}) {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const minTime = options.minTime ?? 3000;

    const t0 = Date.now();
    let ttfi = 0;
    const data = {
        m: [],
        c: [],
        k: [],
        s: [],
        tc: [],
        ac: [],
        gy: [],
        or: [],
        ev: [],
        bc: [],
        bl: [],
        ttfi: 0,
        dur: 0,
        meta: {},
    };
    const boundElements = new Map();

    function rt() {
        return Date.now() - t0;
    }

    function fi() {
        if (!ttfi) {
            ttfi = rt();
            data.ttfi = ttfi;
        }
    }

    function pushEvent(code) {
        if (data.ev.length < limits.events) {
            data.ev.push([code, rt()]);
        }
    }

    function onMouseMove(e) {
        fi();
        if (data.m.length >= limits.mouse) data.m.shift();
        data.m.push([e.clientX + e.movementX * 0.01, e.clientY + e.movementY * 0.01, rt()]);
        pushEvent(0);
    }

    let downTime = 0;

    function onMouseDown() {
        fi();
        downTime = rt();
        pushEvent(1);
    }

    function onMouseUp() {
        pushEvent(2);
    }

    function onClick(e) {
        fi();
        const now = rt();
        pushEvent(3);
        if (data.c.length >= limits.clicks) return;

        const dwell = downTime ? now - downTime : 0;
        const rect = e.target ? e.target.getBoundingClientRect() : null;
        if (rect && rect.width > 0 && rect.height > 0) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            data.c.push([e.clientX - cx, e.clientY - cy, dwell, rect.width, rect.height, now]);
        } else {
            data.c.push([0, 0, dwell, 0, 0, now]);
        }
        downTime = 0;

        for (const [element, index] of boundElements) {
            if (element === e.target || element.contains(e.target)) {
                const br = element.getBoundingClientRect();
                const bx = br.left + br.width / 2;
                const by = br.top + br.height / 2;
                data.bc.push([
                    e.clientX - bx,
                    e.clientY - by,
                    dwell,
                    br.width,
                    br.height,
                    now,
                    index,
                ]);
                break;
            }
        }
    }

    const keyDownTimes = {};
    let lastKeyUp = 0;

    function onKeyDown(e) {
        fi();
        pushEvent(4);
        if (!keyDownTimes[e.code]) {
            keyDownTimes[e.code] = rt();
        }
    }

    function onKeyUp(e) {
        pushEvent(5);
        const now = rt();
        const downT = keyDownTimes[e.code];
        if (downT && data.k.length < limits.keys) {
            const dwell = now - downT;
            const flight = lastKeyUp ? downT - lastKeyUp : 0;
            data.k.push([dwell, flight]);
        }
        lastKeyUp = now;
        delete keyDownTimes[e.code];
    }

    function onScroll() {
        fi();
        const now = rt();
        pushEvent(6);
        if (data.s.length >= limits.scroll) data.s.shift();
        const prev = data.s.length ? data.s[data.s.length - 1][0] : 0;
        data.s.push([window.scrollY, window.scrollY - prev, now]);
    }

    function onTouch(e, code) {
        fi();
        pushEvent(code);
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (data.tc.length >= limits.touch) {
                data.tc.shift();
            }
            const t = e.changedTouches[i];
            data.tc.push([
                t.clientX,
                t.clientY,
                t.force || 0,
                t.radiusX || 0,
                t.radiusY || 0,
                rt(),
            ]);
        }
    }

    function onDeviceMotion(e) {
        data.meta.hasMotionSensors = true;
        const a = e.accelerationIncludingGravity;
        if (a && data.ac.length < limits.sensors) {
            data.ac.push([a.x || 0, a.y || 0, a.z || 0, rt()]);
        }
        const r = e.rotationRate;
        if (r && data.gy.length < limits.sensors) {
            data.gy.push([r.alpha || 0, r.beta || 0, r.gamma || 0, rt()]);
        }
    }

    function onDeviceOrientation(e) {
        if (data.or.length < limits.sensors) {
            data.or.push([e.alpha || 0, e.beta || 0, e.gamma || 0, rt()]);
        }
    }

    function attach(doc, win) {
        const d = doc || document;
        const w = win || window;

        const passive = { passive: true };
        d.addEventListener('mousemove', onMouseMove, passive);
        d.addEventListener('mousedown', onMouseDown, passive);
        d.addEventListener('mouseup', onMouseUp, passive);
        d.addEventListener('click', onClick, passive);
        d.addEventListener('keydown', onKeyDown, passive);
        d.addEventListener('keyup', onKeyUp, passive);
        w.addEventListener('scroll', onScroll, passive);

        d.addEventListener('touchstart', (e) => onTouch(e, 7), passive);
        d.addEventListener('touchmove', (e) => onTouch(e, 8), passive);
        d.addEventListener('touchend', (e) => onTouch(e, 9), passive);

        data.meta.hasTouchScreen = 'ontouchstart' in w || navigator.maxTouchPoints > 0;
        data.meta.hasMotionSensors = false;

        if (w.DeviceMotionEvent) {
            try {
                if (typeof w.DeviceMotionEvent.requestPermission === 'function') {
                    data.meta.sensorPermissionRequired = true;
                }
            } catch {}
            w.addEventListener('devicemotion', onDeviceMotion, passive);
        }

        if (w.DeviceOrientationEvent) {
            w.addEventListener('deviceorientation', onDeviceOrientation, passive);
        }
    }

    function detach(doc, win) {
        const d = doc || document;
        const w = win || window;
        d.removeEventListener('mousemove', onMouseMove);
        d.removeEventListener('mousedown', onMouseDown);
        d.removeEventListener('mouseup', onMouseUp);
        d.removeEventListener('click', onClick);
        d.removeEventListener('keydown', onKeyDown);
        d.removeEventListener('keyup', onKeyUp);
        w.removeEventListener('scroll', onScroll);
        w.removeEventListener('devicemotion', onDeviceMotion);
        w.removeEventListener('deviceorientation', onDeviceOrientation);
    }

    function isReady() {
        if (rt() < minTime) return false;
        return (
            data.m.length >= 10 || data.tc.length >= 5 || data.k.length >= 3 || data.s.length >= 3
        );
    }

    function getData() {
        data.dur = rt();
        return data;
    }

    function stats() {
        return {
            mouse: data.m.length,
            clicks: data.c.length,
            keys: data.k.length,
            scroll: data.s.length,
            touch: data.tc.length,
            accel: data.ac.length,
            gyro: data.gy.length,
            orient: data.or.length,
            events: data.ev.length,
            elapsed: rt(),
        };
    }

    function bind(element, label) {
        if (!element) return;
        const index = data.bl.length;
        data.bl.push(label || element.id || '');
        boundElements.set(element, index);
    }

    function unbind(element) {
        boundElements.delete(element);
    }

    return {
        attach,
        detach,
        bind,
        unbind,
        isReady,
        getData,
        stats,
    };
}

function serializeInteractions(data) {
    return JSON.stringify(data);
}

function deserializeInteractions(json) {
    return typeof json === 'string' ? JSON.parse(json) : json;
}

export {
    createCollector,
    serializeInteractions,
    deserializeInteractions,
    SIGNAL_CATEGORIES,
    DEFAULT_LIMITS,
};
