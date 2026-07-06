window.addEventListener('DOMContentLoaded', async () => {
    if (!window.__TAURI_INTERNALS__ || !window.Terminal) {
        console.error('Tauri или xterm не загружены');
        return;
    }

    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';

    const tauriInvoke = window.__TAURI_INTERNALS__.invoke;

    const tauriListen = (eventName, callback) => {
        window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
            event: eventName,
            target: {kind: 'Any'},
            handler: window.__TAURI_INTERNALS__.transformCallback(callback)
        });
    };

    let config = {
        fontSize: 14,
        fontWeight: 'bold',
        foreground: '#00f0ff'
    };

    try {
        const fileContent = await tauriInvoke('read_config');
        const parsedConfig = JSON.parse(fileContent);
        config = {...config, ...parsedConfig};
    } catch (err) {
        console.log('Внешний конфиг не найден, используем стандартный:', err);
    }

    const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'monospace',
        fontSize: config.fontSize,
        fontWeight: config.fontWeight,
        allowTransparency: true,
        scrollback: 10000,
        scrollSensitivity: 1,
        theme: {
            background: 'rgba(0, 0, 0, 0)',
            foreground: config.foreground,
            cursor: config.foreground,
            selectionBackground: 'rgba(255, 255, 255, 0.25)',
            selectionForeground: '#ffffff'
        }
    });

    const container = document.getElementById('terminal-container');
    if (container) {
        term.open(container);
        term.focus();
    }

    let lastCols = 0;
    let lastRows = 0;

    const getCellSize = () => {
        const dimensions = term._core?._renderService?.dimensions?.css?.cell;
        if (dimensions?.width && dimensions?.height) {
            return {
                width: dimensions.width,
                height: dimensions.height
            };
        }

        return {
            width: Math.max(7, config.fontSize * 0.62),
            height: Math.max(12, config.fontSize * 1.35)
        };
    };

    const getWheelLines = (event) => {
        const cell = getCellSize();
        const rawDelta = typeof event.deltaY === 'number' && event.deltaY !== 0
            ? event.deltaY
            : -(event.wheelDelta || 0);
        const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? rawDelta
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                ? rawDelta * term.rows
                : rawDelta / cell.height;

        return Math.trunc(Math.sign(delta) * Math.max(1, Math.abs(delta)));
    };

    const scrollTerminal = (lines) => {
        if (!Number.isFinite(lines) || lines === 0) return;

        const viewport = term.element?.querySelector('.xterm-viewport');
        const buffer = term.buffer.active;
        const targetLine = Math.max(0, Math.min(buffer.baseY, buffer.viewportY + lines));

        term.scrollToLine(targetLine);
        term.refresh(0, term.rows - 1);

        if (viewport) {
            viewport.scrollTop = targetLine * getCellSize().height;
        }
    };

    const handleWheelScroll = (event) => {
        if (container && !container.contains(event.target)) {
            return true;
        }

        if (event.ctrlKey || term.modes?.mouseTrackingMode !== 'none') {
            return true;
        }

        scrollTerminal(getWheelLines(event));
        event.preventDefault();
        event.stopPropagation();
        return false;
    };

    term.attachCustomWheelEventHandler(handleWheelScroll);

    const wheelTargets = [
        container,
        term.element,
        term.element?.querySelector('.xterm-viewport'),
        term.element?.querySelector('.xterm-screen')
    ].filter(Boolean);

    for (const target of wheelTargets) {
        target.addEventListener('wheel', handleWheelScroll, {
            capture: true,
            passive: false
        });
        target.addEventListener('mousewheel', handleWheelScroll, {
            capture: true,
            passive: false
        });
    }

    window.__liquidTerminal = {
        scrollUp: () => scrollTerminal(-(term.rows - 1)),
        scrollDown: () => scrollTerminal(term.rows - 1),
        scrollInfo: () => ({
            rows: term.rows,
            viewportY: term.buffer.active.viewportY,
            baseY: term.buffer.active.baseY,
            length: term.buffer.active.length
        })
    };

    term.attachCustomKeyEventHandler((event) => {
        if (!event.shiftKey) return true;

        if (event.key === 'PageUp') {
            scrollTerminal(-(term.rows - 1));
            event.preventDefault();
            return false;
        }

        if (event.key === 'PageDown') {
            scrollTerminal(term.rows - 1);
            event.preventDefault();
            return false;
        }

        return true;
    });

    const updateSize = () => {
        if (!container) return;
        const cell = getCellSize();
        const style = getComputedStyle(container);
        const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const availableWidth = container.clientWidth - horizontalPadding;
        const availableHeight = container.clientHeight - verticalPadding;

        const cols = Math.max(2, Math.floor(availableWidth / cell.width));
        const rows = Math.max(1, Math.floor(availableHeight / cell.height));

        if (cols !== lastCols || rows !== lastRows) {
            lastCols = cols;
            lastRows = rows;
            term.resize(cols, rows);
            tauriInvoke('resize_pty', {rows, cols}).catch(console.error);
        }
    };

    window.addEventListener('resize', updateSize);
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(updateSize));
    if (container) {
        resizeObserver.observe(container);
    }

    let initialized = false;
    term.onRender(() => {
        if (!initialized) {
            updateSize();
            initialized = true;
        }
    });

    tauriListen('pty-data', (event) => {
        term.write(event.payload);
    });

    term.onData((data) => {
        tauriInvoke('write_to_pty', {data}).catch(console.error);
    });

    setTimeout(() => {
        tauriInvoke('write_to_pty', {data: '\r'}).catch(console.error);
        updateSize();
    }, 50);

    const titlebar = document.getElementById('custom-titlebar');
    if (titlebar) {
        titlebar.addEventListener('mousedown', (e) => {
            if (e.buttons === 1 && !e.target.classList.contains('titlebar-btn')) {
                tauriInvoke('plugin:window|start_dragging');
            }
        });
    }

    const btnMinimize = document.getElementById('titlebar-minimize');
    if (btnMinimize) {
        btnMinimize.addEventListener('click', () => {
            tauriInvoke('plugin:window|minimize');
        });
    }

    const btnMaximize = document.getElementById('titlebar-maximize');
    if (btnMaximize) {
        btnMaximize.addEventListener('click', async () => {
            const isMaximized = await tauriInvoke('plugin:window|is_maximized');
            if (isMaximized) {
                await tauriInvoke('plugin:window|unmaximize');
            } else {
                await tauriInvoke('plugin:window|maximize');
            }
            setTimeout(updateSize, 60);
        });
    }

    const btnClose = document.getElementById('titlebar-close');
    if (btnClose) {
        btnClose.addEventListener('click', () => {
            tauriInvoke('plugin:window|close');
        });
    }
});
