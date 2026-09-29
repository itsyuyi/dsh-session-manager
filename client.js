/**
 * Client half of @itsyuyi/dsh-session-manager.
 *
 * Two cooperating slot entries share one module-scoped request store:
 *
 *   1. `sidebar.workspaces.session.menu.item` — a destructive "Delete session"
 *      row (after the shipped pin/rename/fork/archive rows). Clicking it closes
 *      the menu and raises a delete request; it never deletes inline.
 *   2. `shell.overlay` — a centered confirmation dialog rendered only while a
 *      request is pending. It mirrors the host's archive-confirm dialog: Escape
 *      and mask click dismiss, the Cancel button is focused on open, the
 *      in-flight and error states live and die with the request, and a refused
 *      live session shows the localized reason inside the dialog.
 *
 * Localization reads `document.documentElement.lang`, which the host locale
 * plugin keeps in sync with the active locale ("zh-CN" for Chinese, "en"
 * otherwise); a MutationObserver re-renders on a live language switch. This
 * avoids depending on `ctx.locale` being injected into this module.
 *
 * Styling copies the host Modal / Button / dialog-status rules under the
 * `dsm-` prefix and references only `--dsw-*` theme tokens, so light and dark
 * themes and the macOS title-bar clearance all follow the host. The stylesheet
 * is inserted once in `apply` and removed on unload.
 */
window.__ModuleLoader__.load({
  id: '@itsyuyi/dsh-session-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/plugins/dsh-session-manager/delete-session';

    /* ---------------------------------------------------------------- */
    /* Localization                                                      */
    /* ---------------------------------------------------------------- */

    const DICTS = {
      zh: {
        menuLabel: '删除会话',
        title: '删除会话',
        desc: '确定要删除会话“{title}”吗？会话记录将被永久移除，此操作不可恢复。',
        close: '关闭',
        cancel: '取消',
        confirm: '删除',
        pending: '正在删除…',
        live: '会话正在运行（有进行中的回合或任务），请等待结束或先停止，再删除。',
        failed: '删除失败，请稍后重试。',
      },
      en: {
        menuLabel: 'Delete session',
        title: 'Delete session',
        desc: 'Delete session “{title}”? Its history will be permanently removed. This cannot be undone.',
        close: 'Close',
        cancel: 'Cancel',
        confirm: 'Delete',
        pending: 'Deleting…',
        live: 'Session is running (a turn or task is in progress); wait for it to finish or stop it first.',
        failed: 'Delete failed, please retry.',
      },
    };

    function activeLang(ctx) {
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang)
        return document.documentElement.lang;
      try {
        const a = ctx && ctx.locale && ctx.locale.getLocale && ctx.locale.getLocale().active;
        if (a) return String(a);
      } catch {
        /* no locale service — fall through */
      }
      return 'en';
    }

    function dictForLang(lang) {
      return String(lang || '').toLowerCase().startsWith('zh') ? DICTS.zh : DICTS.en;
    }

    /** Reactive dictionary: follows `document.documentElement.lang` live. */
    function useDict(ctx) {
      const [lang, setLang] = React.useState(() => activeLang(ctx));
      React.useEffect(() => {
        if (typeof document === 'undefined' || !document.documentElement) return undefined;
        const el = document.documentElement;
        const sync = () => setLang(activeLang(ctx));
        sync();
        let observer;
        try {
          observer = new MutationObserver(sync);
          observer.observe(el, { attributes: true, attributeFilter: ['lang'] });
        } catch {
          observer = undefined;
        }
        let unsubLocale;
        try {
          unsubLocale = ctx && ctx.locale && ctx.locale.subscribe ? ctx.locale.subscribe(sync) : undefined;
        } catch {
          unsubLocale = undefined;
        }
        return () => {
          if (observer) observer.disconnect();
          if (typeof unsubLocale === 'function') unsubLocale();
        };
      }, [ctx]);
      return dictForLang(lang);
    }

    /* ---------------------------------------------------------------- */
    /* Shared request store (module-scoped, plain pub/sub)              */
    /* ---------------------------------------------------------------- */

    function createDeleteStore() {
      let pending = null; // { sessionId, displayTitle } | null
      const listeners = new Set();
      const emit = () => {
        for (const fn of listeners) fn();
      };
      return {
        getSnapshot: () => pending,
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        request(p) {
          pending = p;
          emit();
        },
        clear() {
          if (pending === null) return;
          pending = null;
          emit();
        },
      };
    }

    function usePending(store) {
      const [pending, setPending] = React.useState(store.getSnapshot);
      React.useEffect(() => store.subscribe(() => setPending(store.getSnapshot())), [store]);
      return pending;
    }

    /* ---------------------------------------------------------------- */
    /* Stylesheet (host Modal + Button + dialog-status rules, dsm-)      */
    /* ---------------------------------------------------------------- */

    const CSS = [
      /* Menu row (host Menu.module.css .item + .danger) */
      '.dsm-separator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2);flex:none;}',
      '.dsm-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:8px;background:transparent;cursor:pointer;font-size:13px;line-height:20px;font-family:inherit;color:var(--dsw-alias-state-error-primary);text-align:left;}',
      '.dsm-item:hover:not(:disabled),.dsm-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none;}',
      '.dsm-item:disabled{opacity:.4;cursor:not-allowed;}',
      '.dsm-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-state-error-primary);}',
      '.dsm-icon svg{width:14px;height:14px;}',
      '.dsm-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      /* Modal (host Modal.module.css) */
      '.dsm-modalRoot{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-top-clearance,24px)) 24px;}',
      '.dsm-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);}',
      '.dsm-dialog{position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:24px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);}',
      '.dsm-content{display:flex;flex-direction:column;width:100%;}',
      '.dsm-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px;}',
      '.dsm-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.dsm-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);}',
      '.dsm-close:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsm-close svg{width:14px;height:14px;}',
      '.dsm-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.dsm-body{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px;gap:8px;}',
      '.dsm-body:empty{display:none;}',
      '.dsm-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px;}',
      /* Buttons (host Button.module.css: outline + geometry) */
      '.dsm-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:18px;cursor:pointer;font-size:14px;line-height:22px;height:36px;padding:0 14px;font-family:inherit;color:var(--dsw-alias-label-primary);background:transparent;}',
      '.dsm-btn:disabled{cursor:not-allowed;opacity:.4;}',
      '.dsm-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent;}',
      '.dsm-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsm-deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary);}',
      /* Dialog status + error (host workspace dialog) */
      '.dsm-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}',
      '.dsm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;}',
    ].join('\n');

    /* ---------------------------------------------------------------- */
    /* Icons                                                             */
    /* ---------------------------------------------------------------- */

    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.75 4.25h10.5M6.25 4.25V3.4a1.15 1.15 0 0 1 1.15-1.15h1.2a1.15 1.15 0 0 1 1.15 1.15v.85M4.5 4.25l.42 7.98c.03.6.53 1.07 1.13 1.07h3.9c.6 0 1.1-.47 1.13-1.07l.42-7.98M6.6 6.75v4.25M9.4 6.75v4.25',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M3 3l8 8M11 3l-8 8',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Menu item                                                         */
    /* ---------------------------------------------------------------- */

    function createMenuItem(ctx, store) {
      return function DeleteSessionMenuItem(props) {
        const { sessionId, displayTitle, useMenuOpenState } = props;
        const [, setMenuOpen] = useMenuOpenState();
        const t = useDict(ctx);
        return h(
          React.Fragment,
          null,
          h('div', { className: 'dsm-separator', 'aria-hidden': 'true' }),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'dsm-item',
              title: t.menuLabel,
              onClick: () => {
                setMenuOpen(false);
                store.request({ sessionId, displayTitle: displayTitle || sessionId });
              },
            },
            h('span', { className: 'dsm-icon' }, h(TrashIcon)),
            h('span', { className: 'dsm-label' }, t.menuLabel),
          ),
        );
      };
    }

    /* ---------------------------------------------------------------- */
    /* Confirmation dialog (shell.overlay)                              */
    /* ---------------------------------------------------------------- */

    function createDialog(ctx, store) {
      return function DeleteSessionDialog() {
        const pending = usePending(store);
        const t = useDict(ctx);
        if (!pending) return null;
        // Keyed by session so in-flight/error state dies with its request.
        return h(DeleteDialogForm, { key: pending.sessionId, request: pending, store, t });
      };
    }

    function DeleteDialogForm({ request, store, t }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const cancelRef = React.useRef(null);

      // Dismiss the dialog; ignored while a delete is in flight.
      const requestClose = React.useCallback(() => {
        if (busy) return;
        store.clear();
      }, [busy, store]);

      const confirm = React.useCallback(() => {
        setBusy(true);
        setError(null);
        (async () => {
          try {
            const res = await fetch(ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: request.sessionId }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body && body.ok === true) {
              store.clear();
              return;
            }
            const code = body && body.error;
            setError(code === 'session-live' ? t.live : body && body.message ? String(body.message) : t.failed);
          } catch {
            setError(t.failed);
          } finally {
            setBusy(false);
          }
        })();
      }, [request.sessionId, store, t]);

      // Escape dismisses (unless busy).
      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          if (busy) return;
          e.stopPropagation();
          store.clear();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [busy, store]);

      // Focus the Cancel button on open.
      React.useEffect(() => {
        if (cancelRef.current) cancelRef.current.focus();
      }, []);

      const description = t.desc.replace('{title}', request.displayTitle || request.sessionId);

      return h(
        'div',
        { className: 'dsm-modalRoot', role: 'presentation' },
        h('div', { className: 'dsm-mask', 'aria-hidden': 'true', onClick: requestClose }),
        h(
          'div',
          { className: 'dsm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.title },
          h(
            'div',
            { className: 'dsm-content' },
            h(
              'div',
              { className: 'dsm-header' },
              h('h2', { className: 'dsm-title' }, t.title),
              h(
                'button',
                { type: 'button', className: 'dsm-close', 'aria-label': t.close, onClick: requestClose, disabled: busy },
                h(CloseIcon),
              ),
            ),
            h('p', { className: 'dsm-description' }, description),
            h(
              'div',
              { className: 'dsm-body' },
              busy ? h('div', { className: 'dsm-status', role: 'status' }, t.pending) : null,
              error ? h('div', { className: 'dsm-error', role: 'alert' }, error) : null,
            ),
          ),
          h(
            'div',
            { className: 'dsm-footer' },
            h(
              'button',
              { type: 'button', className: 'dsm-btn dsm-outline', ref: cancelRef, disabled: busy, onClick: requestClose },
              t.cancel,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn dsm-outline dsm-deleteAction',
                disabled: busy,
                onClick: confirm,
              },
              t.confirm,
            ),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* Module face                                                       */
    /* ---------------------------------------------------------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        // One stylesheet for both entries, removed on unload.
        ctx.effect(() => {
          if (typeof document === 'undefined' || !document.head) return () => {};
          const el = document.createElement('style');
          el.setAttribute('data-dsh-session-manager', '');
          el.textContent = CSS;
          document.head.appendChild(el);
          return () => {
            el.remove();
          };
        }, 'dsh-session-manager: styles');

        const store = createDeleteStore();

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-manager.delete', order: 900 },
            createMenuItem(ctx, store),
          ),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-manager.delete-confirm', order: 100 },
            createDialog(ctx, store),
          ),
        );
      },
    };
  },
});
