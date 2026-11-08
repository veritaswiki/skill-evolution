window.__ModuleLoader__.load({
  id: 'skill-evolution',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo } = React;

    const API = '/dsh-evolution/api';

    // ---------- 1. 单例数据层（EvolutionStore + in-flight 去重 + 自适应轮询）----------
    async function api(path, options) {
      const res = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...options,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    const store = {
      data: null,
      error: null,
      loading: true,
      inflight: null,
      listeners: new Set(),
      timer: null,
      notify() {
        for (const fn of this.listeners) {
          try { fn(); } catch { /* ignore */ }
        }
      },
      async fetchNow() {
        if (this.inflight) return this.inflight;
        this.inflight = api('/status')
          .then((snap) => {
            this.data = snap;
            this.error = null;
            this.loading = false;
            this.notify();
            return snap;
          })
          .catch((e) => {
            this.error = String(e.message || e);
            this.loading = false;
            this.notify();
          })
          .finally(() => {
            this.inflight = null;
            this.scheduleNext();
          });
        return this.inflight;
      },
      scheduleNext() {
        if (this.timer) clearTimeout(this.timer);
        if (this.listeners.size === 0) return;
        const isRunning = this.data?.lastReview?.status === 'running';
        const delay = isRunning ? 2000 : 8000;
        this.timer = setTimeout(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            this.scheduleNext();
            return;
          }
          this.fetchNow();
        }, delay);
      },
      subscribe(fn) {
        this.listeners.add(fn);
        if (this.listeners.size === 1) {
          this.fetchNow();
        }
        return () => {
          this.listeners.delete(fn);
          if (this.listeners.size === 0 && this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
          }
        };
      },
    };

    function useSnapshot() {
      const [, setTick] = useState(0);
      useEffect(() => store.subscribe(() => setTick((n) => n + 1)), []);
      const reload = useCallback(() => store.fetchNow(), []);
      return { data: store.data, error: store.error, loading: store.loading, reload };
    }

    // ---------- 2. 图标与通用原子组件（全部在顶层定义，杜绝重挂载失焦）----------
    function Icon({ d, size = 16, style }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.85,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style,
        },
        h('path', { d }),
      );
    }

    const ICONS = {
      spark: 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6l2.1-2.1',
      book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
      clock: 'M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
      undo: 'M3 7v6h6M3.5 13a9 9 0 1 0 2.1-9.4L3 7',
      check: 'M20 6L9 17l-5-5',
      x: 'M18 6L6 18M6 6l12 12',
      pin: 'M12 17v5M9 10.5V4h6v6.5l2 3.5H7l2-3.5z',
      refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
      chevron: 'M9 18l6-6-6-6',
      alert: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
      file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
      play: 'M5 3l14 9-14 9V3z',
      layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
      search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
      settings:
        'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    };

    function Chip({ children, tone, icon, onClick, title }) {
      return h(
        'span',
        {
          className: 'ev-chip' + (tone ? ' ev-chip-' + tone : '') + (onClick ? ' ev-chip-click' : ''),
          onClick,
          title,
        },
        icon ? h(Icon, { d: ICONS[icon], size: 11 }) : null,
        children,
      );
    }

    function StatCard({ label, value, sub, tone, icon, onClick }) {
      return h(
        'div',
        {
          className: 'ev-stat' + (tone ? ' ev-stat-' + tone : '') + (onClick ? ' ev-stat-click' : ''),
          onClick,
        },
        h('div', { className: 'ev-stat-icon' }, h(Icon, { d: ICONS[icon] || ICONS.spark, size: 17 })),
        h(
          'div',
          { className: 'ev-stat-body' },
          h('div', { className: 'ev-stat-value' }, String(value)),
          h('div', { className: 'ev-stat-label' }, label),
          sub ? h('div', { className: 'ev-stat-sub' }, sub) : null,
        ),
      );
    }

    function Empty({ icon, title, hint, action }) {
      return h(
        'div',
        { className: 'ev-empty' },
        h('div', { className: 'ev-empty-icon' }, h(Icon, { d: ICONS[icon] || ICONS.spark, size: 26 })),
        h('div', { className: 'ev-empty-title' }, title),
        hint ? h('div', { className: 'ev-empty-hint' }, hint) : null,
        action ? h('div', { style: { marginTop: '8px' } }, action) : null,
      );
    }

    function Toast({ message, tone, onDone }) {
      useEffect(() => {
        const t = setTimeout(onDone, 3400);
        return () => clearTimeout(t);
      }, [onDone]);
      return h(
        'div',
        { className: 'ev-toast ev-toast-' + (tone || 'ok') },
        h(Icon, { d: tone === 'err' ? ICONS.alert : ICONS.check, size: 15 }),
        h('span', null, message),
      );
    }

    /** 中文简报与强制批示组件（含 AI 批示融合进化闭环） */
    function ReviewBrief({ draft, onSwitchPreview, onRefine, onApprove, onReject, busyKey }) {
      const [comment, setComment] = useState('');
      const isBusy = busyKey === `draft:${draft.name}`;
      const b = draft.briefing || {};
      const keyRules = Array.isArray(b.keyRules) ? b.keyRules : [];
      const quickDirectives = [
        '同意采纳：请将技能正文全部转化为清晰易读的中文规范后正式入库',
        '同意采纳：提炼的排查顺序与防坑规则准确，直接按此入库',
        '同意但需补充：请在步骤开头加入“修改前必须先备份原文件/配置”的硬性要求',
        '不同意驳回：这属于单次特定环境偶发问题，不应固化为全局技能',
      ];

      return h(
        'div',
        { className: 'ev-brief-wrap' },
        // 顶部标题与视图切换
        h(
          'div',
          { className: 'ev-card-head' },
          h(
            'div',
            { className: 'ev-card-title-wrap' },
            h(
              'div',
              { className: 'ev-row-title' },
              h(Chip, { tone: 'brand', icon: 'spark' }, '中文审阅简报'),
              h('code', { className: 'ev-skill-name' }, draft.name),
              h(
                Chip,
                { tone: draft.isPatch ? 'ok' : 'warn' },
                draft.isPatch ? '现有技能升级补丁' : '新蒸馏类级技能',
              ),
            ),
            h('h3', { className: 'ev-brief-title' }, b.titleZh || draft.name),
          ),
          h(
            'div',
            { className: 'ev-card-actions' },
            h(
              'button',
              { className: 'ev-btn ev-btn-ghost', onClick: onSwitchPreview },
              h(Icon, { d: ICONS.file, size: 13 }),
              '查看 SKILL.md 源码全文',
            ),
          ),
        ),

        // 1. 这是什么东西
        h(
          'div',
          { className: 'ev-brief-section' },
          h('div', { className: 'ev-brief-label' }, '💡 这是个什么东西（AI 蒸馏摘要）'),
          h('div', { className: 'ev-brief-text' }, b.whatItIs || draft.description || '(无摘要)'),
          keyRules.length
            ? h(
                'ul',
                { className: 'ev-brief-rules' },
                keyRules.map((rule, idx) => h('li', { key: idx }, rule)),
              )
            : null,
        ),

        // 2. 同意 vs 不同意的影响对比
        h(
          'div',
          { className: 'ev-impact-grid' },
          h(
            'div',
            { className: 'ev-impact-box ev-impact-approve' },
            h('div', { className: 'ev-impact-head' }, '✅ 如果您同意采纳会如何？'),
            h(
              'div',
              { className: 'ev-impact-body' },
              b.ifApprove ||
                'AI 会先根据您的批示修订并完善该技能，然后写入正式技能库（~/.dsh/skills/），后续遇到同类任务自动加载生效。',
            ),
          ),
          h(
            'div',
            { className: 'ev-impact-box ev-impact-reject' },
            h('div', { className: 'ev-impact-head' }, '🚫 如果您不同意驳回会如何？'),
            h(
              'div',
              { className: 'ev-impact-body' },
              b.ifReject ||
                '该草稿将从暂存区销毁，不会改动现有正式技能库，同时将您的驳回批示记入账本防止重复生成。',
            ),
          ),
        ),

        // 3. 如果已经执行过 AI 批示融合，展示 AI 的分析汇报
        b.aiAnalysis
          ? h(
              'div',
              { className: 'ev-ai-analysis' },
              h('div', { className: 'ev-brief-label' }, '🤖 AI 对您上次批示的进化分析与修订汇报'),
              b.lastUserComment
                ? h('div', { className: 'ev-field-hint' }, `您的批示：「${b.lastUserComment}」`)
                : null,
              h('div', { className: 'ev-brief-text', style: { marginTop: '4px' } }, b.aiAnalysis),
            )
          : null,

        // 4. 强制批示输入区
        h(
          'div',
          { className: 'ev-directive-box' },
          h(
            'div',
            { className: 'ev-directive-head' },
            h('label', { className: 'ev-field-label' }, '✍️ 您的审阅批示 / 想法（必填，填写后解锁下方操作）：'),
            h('span', { className: 'ev-field-hint' }, '写下您的补充想法，AI 会先分析融合您的批示再完成本次自进化'),
          ),
          h(
            'div',
            { className: 'ev-quick-directives' },
            quickDirectives.map((q) =>
              h(
                'button',
                {
                  key: q,
                  type: 'button',
                  className: 'ev-chip ev-chip-click',
                  onClick: () => setComment(q),
                },
                '+ ' + q.slice(0, 26) + '…',
              ),
            ),
          ),
          h('textarea', {
            className: 'ev-input ev-textarea',
            placeholder:
              '在此输入您的批示（例如：同意，但把正文改成全中文，并加上一条先备份再修改的规则 / 不同意，理由是…）',
            rows: 3,
            value: comment,
            onChange: (e) => setComment(e.target.value),
          }),
          h(
            'div',
            { className: 'ev-card-actions', style: { marginTop: '10px', justifyContent: 'flex-end' } },
            h(
              'button',
              {
                className: 'ev-btn ev-btn-ghost',
                disabled: isBusy || !comment.trim(),
                onClick: () => onRefine(draft.name, comment),
                title: '让 AI 先根据您的批示重写草稿并生成中文分析，不立即入库，方便您先看效果',
              },
              h(Icon, { d: ICONS.spark, size: 14 }),
              isBusy ? 'AI 正在分析批示…' : '1. AI 按批示修订草稿（先看效果）',
            ),
            h(
              'button',
              {
                className: 'ev-btn ev-btn-primary',
                disabled: isBusy || !comment.trim(),
                onClick: () => onApprove(draft.name, comment),
                title: 'AI 结合您的批示完成最终修订并立即升入正式技能库',
              },
              h(Icon, { d: ICONS.check, size: 14 }),
              isBusy ? '正在进化入库…' : '2. 按批示进化并采纳进正式库',
            ),
            h(
              'button',
              {
                className: 'ev-btn ev-btn-danger',
                disabled: isBusy || !comment.trim(),
                onClick: () => onReject(draft.name, comment),
              },
              h(Icon, { d: ICONS.x, size: 14 }),
              '按批示驳回 (Discard)',
            ),
          ),
        ),
      );
    }

    /** 语法高亮与行号 Markdown 预览器（Argon 视觉规范） */

    function MarkdownCodePreview({ frontmatter, body }) {
      const fmEntries = Object.entries(frontmatter || {}).filter(([, v]) => v !== undefined && v !== '');
      const lines = String(body || '').trim().split('\n');
      return h(
        'div',
        { className: 'ev-md-viewer' },
        fmEntries.length
          ? h(
              'div',
              { className: 'ev-fm-bar' },
              fmEntries.map(([k, v]) =>
                h(
                  'span',
                  { key: k, className: 'ev-fm-item' },
                  h('span', { className: 'ev-fm-key' }, k + ':'),
                  h('span', { className: 'ev-fm-val' }, typeof v === 'object' ? JSON.stringify(v) : String(v)),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'ev-code-lines' },
          lines.map((line, idx) => {
            const isH1 = /^#\s+/.test(line);
            const isH2 = /^#{2,3}\s+/.test(line);
            const isBullet = /^\s*([-*•]|\d+\.)\s+/.test(line);
            const isCodeFence = /^```/.test(line.trim());
            const cls =
              'ev-line' +
              (isH1 ? ' ev-line-h1' : isH2 ? ' ev-line-h2' : isBullet ? ' ev-line-bullet' : isCodeFence ? ' ev-line-fence' : '');
            return h(
              'div',
              { key: idx, className: cls },
              h('span', { className: 'ev-line-num' }, String(idx + 1)),
              h('span', { className: 'ev-line-txt' }, line || '\u00a0'),
            );
          }),
        ),
      );
    }

    /** 账本文件级 SHA-256 结构化 Diff 表格（Argon + Flash 合流规范） */
    function FileDiffTable({ before, after }) {
      const beforeMap = new Map(((before && before.files) || []).map((f) => [f.relPath, f]));
      const afterMap = new Map(((after && after.files) || []).map((f) => [f.relPath, f]));
      const allPaths = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort();

      if (allPaths.length === 0) {
        return h('div', { className: 'ev-field-hint' }, '无快照文件变更记录（归档或仅元数据变更）');
      }

      const rows = allPaths.map((relPath) => {
        const b = beforeMap.get(relPath);
        const a = afterMap.get(relPath);
        let status = 'UNCHANGED';
        let tone = 'idle';
        if (!b && a) {
          status = 'ADDED';
          tone = 'ok';
        } else if (b && !a) {
          status = 'REMOVED';
          tone = 'err';
        } else if (b && a && b.sha !== a.sha) {
          status = 'MODIFIED';
          tone = 'warn';
        }
        return { relPath, b, a, status, tone };
      });

      return h(
        'div',
        { className: 'ev-diff-table-wrap' },
        h(
          'table',
          { className: 'ev-diff-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, '状态'),
              h('th', null, '文件路径'),
              h('th', null, '变更前 SHA'),
              h('th', null, '变更后 SHA'),
              h('th', null, '大小'),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                { key: r.relPath, className: 'ev-diff-row-' + r.tone },
                h('td', null, h(Chip, { tone: r.tone === 'err' ? 'warn' : r.tone }, r.status)),
                h('td', { className: 'ev-mono' }, r.relPath),
                h('td', { className: 'ev-mono ev-sha' }, r.b ? r.b.sha.slice(0, 10) : '—'),
                h('td', { className: 'ev-mono ev-sha' }, r.a ? r.a.sha.slice(0, 10) : '—'),
                h(
                  'td',
                  { className: 'ev-mono' },
                  r.a && r.b
                    ? `${r.b.size}B → ${r.a.size}B`
                    : r.a
                      ? `${r.a.size}B`
                      : `${r.b.size}B`,
                ),
              ),
            ),
          ),
        ),
      );
    }

    // ---------- 3. 业务卡片组件 ----------
    function DraftCard({ draft, onRefine, onPromote, onDiscard, busyKey }) {
      const [view, setView] = useState('brief'); // brief | preview
      const isBusy = busyKey === `draft:${draft.name}`;

      return h(
        'div',
        { className: 'ev-card ev-card-draft' },
        view === 'brief'
          ? h(ReviewBrief, {
              draft,
              busyKey,
              onSwitchPreview: () => setView('preview'),
              onRefine: (name, comment) => onRefine(name, comment),
              onApprove: (name, comment) => onPromote(name, comment),
              onReject: (name, comment) => onDiscard(name, comment),
            })
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'ev-card-head' },
                h(
                  'div',
                  { className: 'ev-card-title-wrap' },
                  h(
                    'div',
                    { className: 'ev-row-title' },
                    h('code', { className: 'ev-skill-name' }, draft.name),
                    h(Chip, { tone: 'warn', icon: 'spark' }, 'SKILL.md 源码预览'),
                  ),
                  h('div', { className: 'ev-card-desc' }, draft.briefing?.titleZh || draft.description || ''),
                ),
                h(
                  'div',
                  { className: 'ev-card-actions' },
                  h(
                    'button',
                    { className: 'ev-btn ev-btn-primary', onClick: () => setView('brief') },
                    '← 返回中文简报与填写批示',
                  ),
                ),
              ),
              h(MarkdownCodePreview, { frontmatter: draft.frontmatter, body: draft.body }),
            ),
      );
    }

    const STATE_TONE = { active: 'ok', stale: 'warn', archived: 'idle' };
    const STATE_LABEL = { active: '活跃', stale: '陈旧', archived: '已归档' };

    function SkillRow({ skill, onPin, onDisown, busyKey }) {
      const [open, setOpen] = useState(false);
      const isBusy = busyKey === `skill:${skill.name}`;
      return h(
        'div',
        { className: 'ev-card' },
        h(
          'div',
          { className: 'ev-row-head' },
          h(
            'div',
            { className: 'ev-row-main' },
            h(
              'div',
              { className: 'ev-row-title' },
              h('code', { className: 'ev-skill-name' }, skill.name),
              skill.createdBy === 'agent' ? h(Chip, { tone: 'brand', icon: 'spark' }, '自进化生成') : null,
              skill.adopted ? h(Chip, { tone: 'ok' }, '已纳管') : null,
              skill.protected ? h(Chip, { tone: 'idle' }, '受保护内置') : null,
              skill.pinned ? h(Chip, { tone: 'warn', icon: 'pin' }, '已固定') : null,
            ),
            h('div', { className: 'ev-row-desc' }, skill.description || '(无描述)'),
            skill.resources && skill.resources.length
              ? h(
                  'div',
                  { className: 'ev-resources', style: { marginTop: '4px' } },
                  skill.resources.map((r) => h(Chip, { key: r, icon: 'file' }, r)),
                )
              : null,
          ),
          h(
            'div',
            { className: 'ev-row-meta' },
            h(Chip, { tone: STATE_TONE[skill.state] || 'idle' }, STATE_LABEL[skill.state] || skill.state),
            h(
              'span',
              { className: 'ev-metric', title: '累计触发/更新次数' },
              h(Icon, { d: ICONS.clock, size: 12 }),
              String(skill.useCount ?? 0),
            ),
            h(
              'button',
              {
                className: 'ev-btn ev-btn-ghost',
                onClick: () => setOpen(!open),
              },
              h(Icon, {
                d: ICONS.chevron,
                size: 13,
                style: { transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' },
              }),
              open ? '收起' : '查看 SKILL.md',
            ),
            skill.adopted
              ? h(
                  'button',
                  {
                    className: 'ev-btn ev-btn-ghost',
                    disabled: isBusy,
                    onClick: () => onDisown(skill.name),
                    title: '取消纳管（保留文件）',
                  },
                  '取消纳管',
                )
              : null,
            h(
              'button',
              {
                className: 'ev-icon-btn' + (skill.pinned ? ' ev-icon-btn-on' : ''),
                title: skill.pinned ? '取消固定' : '固定（豁免自动归档与合并）',
                disabled: isBusy || skill.protected,
                onClick: () => onPin(skill.name, !skill.pinned),
              },
              h(Icon, { d: ICONS.pin, size: 14 }),
            ),
          ),
        ),
        open
          ? skill.body
            ? h(MarkdownCodePreview, { frontmatter: skill.frontmatter, body: skill.body })
            : h('div', { className: 'ev-field-hint' }, '无正文内容')
          : null,
      );
    }

    function LedgerRow({ entry, onRollback, busyKey }) {
      const [open, setOpen] = useState(false);
      const isBusy = busyKey === `rollback:${entry.id}`;
      const actionTone =
        entry.action.startsWith('draft')
          ? 'warn'
          : entry.action === 'rollback'
            ? 'idle'
            : entry.action === 'promote' || entry.action.startsWith('curator_')
              ? 'ok'
              : 'brand';

      return h(
        'div',
        { className: 'ev-card' },
        h(
          'div',
          { className: 'ev-row-head' },
          h(
            'div',
            { className: 'ev-row-main' },
            h(
              'div',
              { className: 'ev-row-title' },
              h(Chip, { tone: actionTone }, entry.action),
              h('code', { className: 'ev-skill-name' }, entry.target),
              entry.absorbedInto ? h(Chip, { tone: 'brand' }, `→ ${entry.absorbedInto}`) : null,
              h(
                'span',
                { className: 'ev-ts' },
                new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
              ),
              h('span', { className: 'ev-ts' }, `actor=${entry.actor}`),
            ),
            entry.rationale ? h('div', { className: 'ev-row-desc' }, entry.rationale) : null,
            entry.signals && entry.signals.length
              ? h(
                  'div',
                  { className: 'ev-signals' },
                  entry.signals.map((s) => h(Chip, { key: s, tone: 'idle' }, s)),
                )
              : null,
          ),
          h(
            'div',
            { className: 'ev-row-meta' },
            h(
              'button',
              { className: 'ev-btn ev-btn-ghost', onClick: () => setOpen(!open) },
              h(Icon, {
                d: ICONS.chevron,
                size: 13,
                style: { transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' },
              }),
              open ? '收起 Diff' : 'SHA 对比',
            ),
            entry.before && Array.isArray(entry.before.files)
              ? h(
                  'button',
                  {
                    className: 'ev-btn ev-btn-danger',
                    disabled: isBusy,
                    onClick: () => onRollback(entry.id, entry.target),
                    title: '回滚到这条变更之前的状态',
                  },
                  h(Icon, { d: ICONS.undo, size: 13 }),
                  isBusy ? '回滚中…' : '回滚',
                )
              : null,
          ),
        ),
        open ? h(FileDiffTable, { before: entry.before, after: entry.after }) : null,
      );
    }

    // ---------- 4. 设置面板（子组件已提升至顶层，彻底解决输入失焦 Bug）----------
    function SettingField({ label, hint, children }) {
      return h(
        'div',
        { className: 'ev-field' },
        h('div', { className: 'ev-field-label' }, label),
        children,
        hint ? h('div', { className: 'ev-field-hint' }, hint) : null,
      );
    }

    function SettingNumberInput({ value, min, max, step, onChange }) {
      return h('input', {
        type: 'number',
        className: 'ev-input',
        value: value ?? '',
        min,
        max,
        step,
        onChange: (e) => onChange(Number(e.target.value)),
      });
    }

    function SettingsPanel({ config, onSave, busyKey }) {
      const [draft, setDraft] = useState(config);
      useEffect(() => setDraft(config), [config]);
      const dirty = JSON.stringify(draft) !== JSON.stringify(config);
      const set = (k, v) => setDraft((prev) => ({ ...prev, [k]: v }));
      const isBusy = busyKey === 'config';

      return h(
        'div',
        { className: 'ev-settings' },
        h(
          'div',
          { className: 'ev-settings-grid' },
          h(
            SettingField,
            { label: '启用自进化复盘', hint: '总开关：关闭后不再在回合结束时触发自动复盘，但 UI 与命令仍可用' },
            h(
              'label',
              { className: 'ev-switch' },
              h('input', {
                type: 'checkbox',
                checked: draft.enabled !== false,
                onChange: (e) => set('enabled', e.target.checked),
              }),
              h('span', { className: 'ev-switch-track' }, h('span', { className: 'ev-switch-thumb' })),
            ),
          ),
          h(
            SettingField,
            { label: '落盘模式 (Mode)', hint: 'draft 只写 .staging/ 等人工采纳（推荐）；apply 通过闸门后直接写入正式库' },
            h(
              'select',
              { className: 'ev-input', value: draft.mode || 'draft', onChange: (e) => set('mode', e.target.value) },
              h('option', { value: 'draft' }, 'draft · 草稿审阅模式（推荐）'),
              h('option', { value: 'apply' }, 'apply · 全自动落盘模式'),
            ),
          ),
          h(
            SettingField,
            { label: '生命周期维护 (Curator)', hint: '自动按活动时间把长期未用技能标记为 stale / 移入 .archive（永不删除）' },
            h(
              'label',
              { className: 'ev-switch' },
              h('input', {
                type: 'checkbox',
                checked: !!draft.curatorEnabled,
                onChange: (e) => set('curatorEnabled', e.target.checked),
              }),
              h('span', { className: 'ev-switch-track' }, h('span', { className: 'ev-switch-thumb' })),
            ),
          ),
          h(
            SettingField,
            { label: '定时 LLM 建伞合并', hint: '在后台 curator 周期中自动把多个窄技能合并成类级别伞技能' },
            h(
              'label',
              { className: 'ev-switch' },
              h('input', {
                type: 'checkbox',
                checked: !!draft.consolidate,
                onChange: (e) => set('consolidate', e.target.checked),
              }),
              h('span', { className: 'ev-switch-track' }, h('span', { className: 'ev-switch-thumb' })),
            ),
          ),
          h(
            SettingField,
            { label: '建伞合并仅预览 (Dry-Run)', hint: '开启时后台合并只输出计划而不直接改动磁盘' },
            h(
              'label',
              { className: 'ev-switch' },
              h('input', {
                type: 'checkbox',
                checked: draft.consolidateDryRun !== false,
                onChange: (e) => set('consolidateDryRun', e.target.checked),
              }),
              h('span', { className: 'ev-switch-track' }, h('span', { className: 'ev-switch-thumb' })),
            ),
          ),
          h(
            SettingField,
            { label: '复盘专用模型（可选）', hint: '留空默认使用快速辅助模型，避免消耗主模型高阶配额' },
            h('input', {
              type: 'text',
              className: 'ev-input',
              placeholder: 'deepseek-chat',
              value: draft.reviewModel?.model || '',
              onChange: (e) =>
                set('reviewModel', { ...(draft.reviewModel || {}), model: e.target.value }),
            }),
          ),
          h(
            SettingField,
            { label: '复盘节流：最少有效回合数', hint: '两次自动复盘之间至少间隔多少个含复杂工具调用/用户纠正的回合' },
            h(SettingNumberInput, {
              value: draft.minTurnsBetween,
              min: 1,
              max: 50,
              onChange: (v) => set('minTurnsBetween', v),
            }),
          ),
          h(
            SettingField,
            { label: '复盘节流：最少间隔分钟数', hint: '两次自动复盘之间至少间隔多少分钟' },
            h(SettingNumberInput, {
              value: draft.minMinutesBetween,
              min: 0,
              max: 1440,
              onChange: (v) => set('minMinutesBetween', v),
            }),
          ),
          h(
            SettingField,
            { label: '快照保留消息数', hint: '送给复盘模型的最近原文消息条数（更早的自动压缩为摘要）' },
            h(SettingNumberInput, {
              value: draft.maxMessages,
              min: 4,
              max: 200,
              onChange: (v) => set('maxMessages', v),
            }),
          ),
          h(
            SettingField,
            { label: '快照字符上限', hint: '单次复盘的最大上下文字符预算' },
            h(SettingNumberInput, {
              value: draft.maxChars,
              min: 2000,
              max: 200000,
              step: 1000,
              onChange: (v) => set('maxChars', v),
            }),
          ),
          h(
            SettingField,
            { label: '复盘超时（秒）', hint: '单次后台复盘最长允许运行时间' },
            h(SettingNumberInput, {
              value: draft.reviewTimeoutSeconds,
              min: 30,
              max: 1800,
              onChange: (v) => set('reviewTimeoutSeconds', v),
            }),
          ),
          h(
            SettingField,
            { label: '陈旧阈值 / 归档阈值（天）', hint: '多少天未用标记为 stale（默认 14）/ 移入 .archive（默认 30）' },
            h(
              'div',
              { style: { display: 'flex', gap: '8px' } },
              h(SettingNumberInput, {
                value: draft.staleAfterDays,
                min: 1,
                max: 365,
                onChange: (v) => set('staleAfterDays', v),
              }),
              h(SettingNumberInput, {
                value: draft.archiveAfterDays,
                min: 1,
                max: 3650,
                onChange: (v) => set('archiveAfterDays', v),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ev-settings-foot' },
          h('div', { className: 'ev-field-hint' }, '技能根目录：', h('code', null, config.skillsRoot)),
          h(
            'button',
            {
              className: 'ev-btn ev-btn-primary',
              disabled: !dirty || isBusy,
              onClick: () => onSave(draft),
            },
            h(Icon, { d: ICONS.check, size: 14 }),
            isBusy ? '保存中…' : dirty ? '保存配置' : '已同步',
          ),
        ),
      );
    }

    // ---------- 5. 主工作台（同时服务 conversation.view 顶部视图栏与 settings.section）----------
    function EvolutionPanel() {
      const { data, error, loading, reload } = useSnapshot();
      const [tab, setTab] = useState('overview');
      const [busyKey, setBusyKey] = useState(null);
      const [toast, setToast] = useState(null);
      const [skillQuery, setSkillQuery] = useState('');
      const [skillFilter, setSkillFilter] = useState('all');
      const [consolidationPlan, setConsolidationPlan] = useState(null);
      const [lastManualReview, setLastManualReview] = useState(null);

      const act = useCallback(
        async (key, fn, okMsg) => {
          setBusyKey(key);
          try {
            const res = await fn();
            if (okMsg) {
              setToast({
                message: typeof okMsg === 'function' ? okMsg(res) : okMsg,
                tone: 'ok',
              });
            }
            await reload();
            return res;
          } catch (e) {
            setToast({ message: String(e.message || e), tone: 'err' });
            return null;
          } finally {
            setBusyKey(null);
          }
        },
        [reload],
      );

      if (loading && !data) {
        return h('div', { className: 'ev-root' }, h('div', { className: 'ev-loading' }, '正在加载 DSH 自进化工作台…'));
      }
      if (error && !data) {
        return h(
          'div',
          { className: 'ev-root' },
          h(Empty, {
            icon: 'alert',
            title: '无法连接自进化服务',
            hint: error,
            action: h(
              'button',
              { className: 'ev-btn ev-btn-primary', onClick: () => reload() },
              '重试连接',
            ),
          }),
        );
      }

      const stats = data?.stats ?? {
        skills: 0,
        agentCreated: 0,
        drafts: 0,
        ledger: 0,
        unmanaged: 0,
        candidates: 0,
        byState: {},
      };
      const config = data?.config ?? {};
      const lastReview = data?.lastReview ?? null;
      const throttle = data?.throttle ?? { turnCount: 0, lastRunAt: 0 };

      const tabs = [
        { id: 'overview', label: '全景概览', icon: 'spark' },
        { id: 'drafts', label: '待审草稿', icon: 'file', badge: stats.drafts, alert: stats.drafts > 0 },
        { id: 'skills', label: '技能库 & 建伞', icon: 'book', badge: stats.skills },
        { id: 'ledger', label: '变更账本 (SHA)', icon: 'clock', badge: stats.ledger },
        { id: 'settings', label: '引擎配置', icon: 'settings' },
      ];

      const handleRollback = (id, target) =>
        act(
          `rollback:${id}`,
          () => api('/rollback', { method: 'POST', body: JSON.stringify({ id }) }),
          `已回滚「${target}」`,
        );

      const handleManualReview = () =>
        act(
          'manual-review',
          async () => {
            const r = await api('/review', { method: 'POST', body: '{}' });
            setLastManualReview(r);
            return r;
          },
          (r) => r?.message || '复盘完成',
        );

      const handlePreviewConsolidate = () =>
        act(
          'consolidate-preview',
          async () => {
            const r = await api('/consolidate', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
            setConsolidationPlan(r);
            return r;
          },
          (r) =>
            r?.skipped
              ? `建伞分析：${r.reason}`
              : `已生成 ${(r?.planned || []).length} 项建伞合并计划`,
        );

      const handleApplyConsolidate = () =>
        act(
          'consolidate-apply',
          async () => {
            const r = await api('/consolidate', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
            setConsolidationPlan(r);
            return r;
          },
          (r) => `已执行合并：${(r?.done || []).length} 项变更已记入账本`,
        );

      // ---- 最近一次复盘状态横幅 ----
      function renderLastReviewBanner() {
        const lr = lastReview;
        if (!lr) return null;
        const tone =
          lr.status === 'saved'
            ? 'ok'
            : lr.status === 'running'
              ? 'brand'
              : lr.status === 'rejected' || lr.status === 'error'
                ? 'warn'
                : 'idle';
        const statusLabel =
          lr.status === 'saved'
            ? `已产出技能 (${lr.action} → ${lr.target})`
            : lr.status === 'running'
              ? '正在后台复盘…'
              : lr.status === 'nothing'
                ? '复盘完成：无需新增技能'
                : lr.status === 'rejected'
                  ? '被安全闸门拦截'
                  : '复盘异常';
        return h(
          'div',
          { className: 'ev-banner ev-banner-' + tone },
          h(
            'div',
            { className: 'ev-banner-main' },
            h(
              'div',
              { className: 'ev-row-title' },
              h(Chip, { tone, icon: 'spark' }, '最近复盘'),
              h('strong', null, statusLabel),
              lr.ts
                ? h('span', { className: 'ev-ts' }, new Date(lr.ts).toLocaleString('zh-CN', { hour12: false }))
                : null,
            ),
            lr.rationale || lr.error
              ? h('div', { className: 'ev-banner-desc' }, lr.rationale || lr.error)
              : null,
          ),
          h(
            'div',
            { className: 'ev-row-meta' },
            lr.status === 'saved' && lr.mode === 'draft'
              ? h(
                  'button',
                  { className: 'ev-btn ev-btn-primary', onClick: () => setTab('drafts') },
                  '前往审阅 →',
                )
              : null,
          ),
        );
      }

      // ---- 1) 概览标签页 ----
      function renderOverview() {
        const pipelineSteps = [
          {
            title: '回合结束监听',
            desc: 'turn/end + session/flush 屏障',
            metric: `${throttle.turnCount || 0}/${config.minTurnsBetween || 3} 回合`,
            tone: config.enabled ? 'ok' : 'idle',
          },
          {
            title: '有界快照采集',
            desc: `保留最近 ${config.maxMessages || 24} 条 · 过滤系统注入`,
            metric: `${Math.round((config.maxChars || 24000) / 1000)}k 预算`,
            tone: 'brand',
          },
          {
            title: '只读复盘蒸馏',
            desc: '移植 Hermes 15 条核心规则',
            metric: lastReview?.status ? `最近: ${lastReview.status}` : '就绪',
            tone: lastReview?.status === 'running' ? 'warn' : 'ok',
          },
          {
            title: '四道安全闸门',
            desc: '类级命名 · 禁词拦截 · 24k 上限',
            metric: '硬拦截开启',
            tone: 'ok',
          },
          {
            title: config.mode === 'apply' ? '自动落盘生效' : '草稿隔离暂存',
            desc: config.mode === 'apply' ? '直接写入 ~/.dsh/skills' : '写入 .staging 等待审阅',
            metric: `${stats.drafts} 待审 / ${stats.skills} 正式`,
            tone: stats.drafts > 0 ? 'warn' : 'ok',
          },
          {
            title: 'SHA 账本与建伞',
            desc: 'JSONL + 内容寻址 blob · 单条回滚',
            metric: `${stats.ledger} 条记录`,
            tone: 'brand',
          },
        ];

        return h(
          React.Fragment,
          null,
          renderLastReviewBanner(),
          h(
            'div',
            { className: 'ev-stats' },
            h(StatCard, {
              label: '正式技能库',
              value: stats.skills,
              sub: `${stats.agentCreated} 个由自进化生成 · 点击查看`,
              icon: 'book',
              tone: 'brand',
              onClick: () => setTab('skills'),
            }),
            h(StatCard, {
              label: '待审阅草稿 (.staging)',
              value: stats.drafts,
              sub: stats.drafts ? '点击立即审阅采纳 →' : '当前无积压草稿',
              icon: 'file',
              tone: stats.drafts ? 'warn' : 'ok',
              onClick: () => setTab('drafts'),
            }),
            h(StatCard, {
              label: 'SHA-256 账本记录',
              value: stats.ledger,
              sub: '每次变更可单条原子回滚',
              icon: 'clock',
              onClick: () => setTab('ledger'),
            }),
            h(StatCard, {
              label: '生命周期分布',
              value: `${stats.byState.active || 0} / ${stats.byState.stale || 0} / ${stats.byState.archived || 0}`,
              sub: '活跃 / 陈旧 / 已归档（永不删除）',
              icon: 'layers',
              tone: 'ok',
              onClick: () => setTab('skills'),
            }),
          ),
          h(
            'section',
            { className: 'ev-section' },
            h(
              'div',
              { className: 'ev-section-head' },
              h('h2', { className: 'ev-section-title' }, '6 步闭环实时状态条 (Closed Learning Loop)'),
              h(
                'div',
                { className: 'ev-section-actions' },
                h(
                  'button',
                  {
                    className: 'ev-btn ev-btn-primary',
                    disabled: busyKey === 'manual-review',
                    onClick: handleManualReview,
                  },
                  h(Icon, { d: ICONS.play, size: 13 }),
                  busyKey === 'manual-review' ? '正在复盘当前会话…' : '立即复盘当前会话',
                ),
              ),
            ),
            h(
              'div',
              { className: 'ev-flow' },
              pipelineSteps.map((step, i) =>
                h(
                  'div',
                  { key: step.title, className: 'ev-flow-step' },
                  h(
                    'div',
                    { className: 'ev-flow-top' },
                    h('div', { className: 'ev-flow-num' }, String(i + 1)),
                    h(Chip, { tone: step.tone }, step.metric),
                  ),
                  h('div', { className: 'ev-flow-title' }, step.title),
                  h('div', { className: 'ev-flow-desc' }, step.desc),
                ),
              ),
            ),
          ),
          h(
            'section',
            { className: 'ev-section' },
            h(
              'div',
              { className: 'ev-section-head' },
              h('h2', { className: 'ev-section-title' }, '最近变更账本'),
              (data.recentLedger || []).length > 6
                ? h(
                    'button',
                    { className: 'ev-btn ev-btn-ghost', onClick: () => setTab('ledger') },
                    '查看全部 →',
                  )
                : null,
            ),
            (data.recentLedger || []).length
              ? h(
                  'div',
                  { className: 'ev-list' },
                  data.recentLedger.slice(0, 6).map((e) =>
                    h(LedgerRow, {
                      key: e.id,
                      entry: e,
                      busyKey,
                      onRollback: handleRollback,
                    }),
                  ),
                )
              : h(Empty, {
                  icon: 'clock',
                  title: '还没有变更记录',
                  hint: '开启自进化后，每次生成草稿、采纳、建伞合并或回滚都会记入 SHA-256 账本',
                }),
          ),
        );
      }

      // ---- 2) 待审草稿标签页 ----
      function renderDrafts() {
        return h(
          'section',
          { className: 'ev-section' },
          h(
            'div',
            { className: 'ev-section-head' },
            h(
              'div',
              null,
              h('h2', { className: 'ev-section-title' }, `待审阅草稿 (${(data.drafts || []).length})`),
              h(
                'div',
                { className: 'ev-field-hint' },
                '草稿保存在 ~/.dsh/skills/.staging/ 下，点击「采纳进正式库」后将立即通过 DSH 热更新注入当前会话可用技能目录。',
              ),
            ),
            h(
              'div',
              { className: 'ev-section-actions' },
              h(
                'button',
                {
                  className: 'ev-btn ev-btn-primary',
                  disabled: busyKey === 'manual-review',
                  onClick: handleManualReview,
                },
                h(Icon, { d: ICONS.play, size: 13 }),
                busyKey === 'manual-review' ? '正在复盘…' : '手动复盘当前会话',
              ),
            ),
          ),
          lastManualReview
            ? h(
                'div',
                { className: 'ev-banner ev-banner-brand' },
                h('div', { className: 'ev-banner-main' }, h('strong', null, lastManualReview.message)),
              )
            : null,
          (data.drafts || []).length
            ? h(
                'div',
                { className: 'ev-list' },
                data.drafts.map((d) =>
                  h(DraftCard, {
                    key: d.name,
                    draft: d,
                    busyKey,
                    onRefine: (name, comment) =>
                      act(
                        `draft:${name}`,
                        () => api('/refine-draft', { method: 'POST', body: JSON.stringify({ name, comment }) }),
                        (r) => `AI 已按您的批示修订草稿：${r?.aiAnalysis || name}`,
                      ),
                    onPromote: (name, comment) =>
                      act(
                        `draft:${name}`,
                        () =>
                          api('/promote', {
                            method: 'POST',
                            body: JSON.stringify({ name, comment, evolveWithComment: true }),
                          }),
                        (r) =>
                          r?.aiAnalysis
                            ? `已按批示进化并采纳「${name}」：${r.aiAnalysis}`
                            : `已采纳「${name}」并热更新至 DSH 技能目录`,
                      ),
                    onDiscard: (name, comment) =>
                      act(
                        `draft:${name}`,
                        () => api('/discard', { method: 'POST', body: JSON.stringify({ name, comment }) }),
                        `已按批示驳回草稿「${name}」并记入账本`,
                      ),
                  }),
                ),
              )
            : h(Empty, {
                icon: 'file',
                title: '当前没有待审阅的技能草稿',
                hint: '当会话出现用户纠正或复杂技术排查时，自进化会自动蒸馏草稿到这里；你也可以点击右上角「手动复盘当前会话」立即触发。',
              }),
        );
      }

      // ---- 3) 技能库 & 建伞合并工作台 ----
      function renderSkills() {
        const unmanaged = data.unmanaged || [];
        const allSkills = data.skills || [];
        const candidates = allSkills.filter((s) => !s.pinned && !s.protected);

        const filtered = allSkills.filter((s) => {
          if (skillFilter === 'active' && s.state !== 'active') return false;
          if (skillFilter === 'stale' && s.state !== 'stale') return false;
          if (skillFilter === 'archived' && s.state !== 'archived') return false;
          if (skillFilter === 'agent' && s.createdBy !== 'agent') return false;
          if (skillQuery.trim()) {
            const q = skillQuery.trim().toLowerCase();
            return (
              s.name.toLowerCase().includes(q) ||
              String(s.description || '').toLowerCase().includes(q)
            );
          }
          return true;
        });

        return h(
          React.Fragment,
          null,
          // 建伞合并工作台卡片
          h(
            'section',
            { className: 'ev-card ev-workbench' },
            h(
              'div',
              { className: 'ev-section-head' },
              h(
                'div',
                null,
                h(
                  'div',
                  { className: 'ev-row-title' },
                  h(Icon, { d: ICONS.layers, size: 16 }),
                  h('h2', { className: 'ev-section-title' }, 'Curator 建伞合并工作台 (Umbrella Consolidation)'),
                  h(Chip, { tone: 'brand' }, `可合并候选: ${candidates.length}`),
                ),
                h(
                  'div',
                  { className: 'ev-field-hint' },
                  '移植自 Hermes CURATOR_REVIEW_PROMPT：自动扫描前缀聚类，把零散的窄技能蒸馏合并为类级别伞技能（只归档不删除，全程记账可回滚）。',
                ),
              ),
              h(
                'div',
                { className: 'ev-section-actions' },
                h(
                  'button',
                  {
                    className: 'ev-btn ev-btn-ghost',
                    disabled: busyKey === 'consolidate-preview' || candidates.length < 2,
                    onClick: handlePreviewConsolidate,
                  },
                  h(Icon, { d: ICONS.spark, size: 13 }),
                  busyKey === 'consolidate-preview' ? '正在分析候选技能…' : '1. 预览合并计划 (Dry-Run)',
                ),
                consolidationPlan && Array.isArray(consolidationPlan.planned) && consolidationPlan.planned.length > 0
                  ? h(
                      'button',
                      {
                        className: 'ev-btn ev-btn-primary',
                        disabled: busyKey === 'consolidate-apply',
                        onClick: handleApplyConsolidate,
                      },
                      h(Icon, { d: ICONS.check, size: 13 }),
                      busyKey === 'consolidate-apply' ? '正在执行合并…' : '2. 确认执行合并',
                    )
                  : null,
              ),
            ),
            consolidationPlan
              ? h(
                  'div',
                  { className: 'ev-plan-box' },
                  consolidationPlan.summary
                    ? h('div', { className: 'ev-plan-summary' }, '分析摘要：' + consolidationPlan.summary)
                    : null,
                  consolidationPlan.skipped
                    ? h('div', { className: 'ev-field-hint' }, '跳过原因：' + consolidationPlan.reason)
                    : null,
                  Array.isArray(consolidationPlan.planned) && consolidationPlan.planned.length
                    ? h(
                        'div',
                        { className: 'ev-plan-list' },
                        consolidationPlan.planned.map((item, i) =>
                          h('div', { key: i, className: 'ev-plan-item' }, h(Chip, { tone: 'warn' }, '计划'), h('code', null, item)),
                        ),
                      )
                    : null,
                  Array.isArray(consolidationPlan.done) && consolidationPlan.done.length
                    ? h(
                        'div',
                        { className: 'ev-plan-list' },
                        consolidationPlan.done.map((item, i) =>
                          h('div', { key: i, className: 'ev-plan-item' }, h(Chip, { tone: 'ok' }, '已完成'), h('code', null, item)),
                        ),
                      )
                    : null,
                )
              : null,
          ),

          // 技能搜索与过滤栏
          h(
            'section',
            { className: 'ev-section' },
            h(
              'div',
              { className: 'ev-filter-bar' },
              h(
                'div',
                { className: 'ev-search-wrap' },
                h(Icon, { d: ICONS.search, size: 14 }),
                h('input', {
                  type: 'text',
                  className: 'ev-search-input',
                  placeholder: '搜索技能名称或描述…',
                  value: skillQuery,
                  onChange: (e) => setSkillQuery(e.target.value),
                }),
              ),
              h(
                'div',
                { className: 'ev-filter-pills' },
                [
                  ['all', `全部 (${allSkills.length})`],
                  ['agent', `自进化 (${stats.agentCreated})`],
                  ['active', `活跃 (${stats.byState.active || 0})`],
                  ['stale', `陈旧 (${stats.byState.stale || 0})`],
                  ['archived', `已归档 (${stats.byState.archived || 0})`],
                ].map(([id, label]) =>
                  h(
                    'button',
                    {
                      key: id,
                      className: 'ev-pill-btn' + (skillFilter === id ? ' ev-pill-btn-on' : ''),
                      onClick: () => setSkillFilter(id),
                    },
                    label,
                  ),
                ),
              ),
            ),
            filtered.length
              ? h(
                  'div',
                  { className: 'ev-list' },
                  filtered.map((s) =>
                    h(SkillRow, {
                      key: s.name,
                      skill: s,
                      busyKey,
                      onPin: (name, pinned) =>
                        act(
                          `skill:${name}`,
                          () => api('/pin', { method: 'POST', body: JSON.stringify({ name, pinned }) }),
                          pinned ? `已固定「${name}」` : `已取消固定「${name}」`,
                        ),
                      onDisown: (name) =>
                        act(
                          `skill:${name}`,
                          () => api('/disown', { method: 'POST', body: JSON.stringify({ name }) }),
                          `已取消纳管「${name}」`,
                        ),
                    }),
                  ),
                )
              : h(Empty, {
                  icon: 'book',
                  title: '没有匹配的技能',
                  hint: `技能根目录：${config.skillsRoot || '(未配置)'}`,
                }),
          ),

          // 未纳管技能
          unmanaged.length
            ? h(
                'section',
                { className: 'ev-section' },
                h('h2', { className: 'ev-section-title' }, `未纳管技能 (${unmanaged.length})`),
                h(
                  'p',
                  { className: 'ev-field-hint' },
                  '这些技能由用户手写或外部导入（无 metadata.createdBy: agent），自进化默认绝不触碰。点击「纳管」可将其纳入生命周期统计，但仍绝不自动篡改其正文。',
                ),
                h(
                  'div',
                  { className: 'ev-list' },
                  unmanaged.map((name) =>
                    h(
                      'div',
                      { key: name, className: 'ev-row' },
                      h(
                        'div',
                        { className: 'ev-row-main' },
                        h(
                          'div',
                          { className: 'ev-row-title' },
                          h('code', { className: 'ev-skill-name' }, name),
                          h(Chip, { tone: 'idle' }, '外部/手写 (未纳管)'),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ev-row-meta' },
                        h(
                          'button',
                          {
                            className: 'ev-btn ev-btn-ghost',
                            disabled: busyKey === `adopt:${name}`,
                            onClick: () =>
                              act(
                                `adopt:${name}`,
                                () => api('/adopt', { method: 'POST', body: JSON.stringify({ name }) }),
                                `已纳管「${name}」`,
                              ),
                          },
                          '纳入生命周期管理',
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : null,
        );
      }

      // ---- 4) 变更账本标签页 ----
      function renderLedger() {
        return h(
          'section',
          { className: 'ev-section' },
          h(
            'div',
            { className: 'ev-section-head' },
            h(
              'div',
              null,
              h('h2', { className: 'ev-section-title' }, `变更账本 (${(data.recentLedger || []).length})`),
              h(
                'div',
                { className: 'ev-field-hint' },
                '每次技能修改均在 .evolution_ledger.jsonl 记录前后文件清单，内容按 SHA-256 去重存入 .evolution_backups/blobs/。回滚具备 fail-closed 安全保护。',
              ),
            ),
          ),
          (data.recentLedger || []).length
            ? h(
                'div',
                { className: 'ev-list' },
                data.recentLedger.map((e) =>
                  h(LedgerRow, {
                    key: e.id,
                    entry: e,
                    busyKey,
                    onRollback: handleRollback,
                  }),
                ),
              )
            : h(Empty, {
                icon: 'clock',
                title: '账本为空',
                hint: '每次技能草稿生成、采纳、建伞合并或回滚都会追加一条可回滚记录',
              }),
        );
      }

      // ---- 5) 设置标签页 ----
      function renderSettings() {
        return h(SettingsPanel, {
          config,
          busyKey,
          onSave: (patch) =>
            act(
              'config',
              () => api('/config', { method: 'POST', body: JSON.stringify(patch) }),
              '配置已保存并持久化',
            ),
        });
      }

      const CONTENT = {
        overview: renderOverview,
        drafts: renderDrafts,
        skills: renderSkills,
        ledger: renderLedger,
        settings: renderSettings,
      };

      const header = h(
        'header',
        { className: 'ev-head' },
        h(
          'div',
          { className: 'ev-head-left' },
          h('div', { className: 'ev-logo' }, h(Icon, { d: ICONS.spark, size: 20 })),
          h(
            'div',
            null,
            h(
              'div',
              { className: 'ev-row-title' },
              h('h1', { className: 'ev-title' }, 'DSH 自进化工作台'),
              h(Chip, { tone: 'brand' }, 'Hermes Parity v0.3'),
            ),
            h(
              'p',
              { className: 'ev-subtitle' },
              'Closed Learning Loop · 回合后自动复盘蒸馏 SKILL.md · 四道安全闸门 · SHA-256 内容寻址账本与建伞合并',
            ),
          ),
        ),
        h(
          'div',
          { className: 'ev-head-right' },
          h(
            Chip,
            { tone: config.enabled ? 'ok' : 'idle', icon: 'spark' },
            config.enabled ? '引擎运行中' : '已停用',
          ),
          h(
            Chip,
            { tone: config.mode === 'apply' ? 'warn' : 'brand' },
            config.mode === 'apply' ? '自动落盘 (apply)' : '草稿审阅 (draft)',
          ),
          h(
            Chip,
            { tone: 'idle', title: '跨进程持久化节流计数' },
            `节流: ${throttle.turnCount || 0}/${config.minTurnsBetween || 3} 回合`,
          ),
          stats.drafts > 0
            ? h(
                Chip,
                { tone: 'warn', onClick: () => setTab('drafts') },
                `${stats.drafts} 个待审草稿`,
              )
            : null,
          h(
            'button',
            {
              className: 'ev-icon-btn',
              title: '立即刷新状态',
              disabled: busyKey === 'refresh',
              onClick: () => act('refresh', () => reload(), '状态已同步'),
            },
            h(Icon, { d: ICONS.refresh, size: 15 }),
          ),
        ),
      );

      const nav = h(
        'nav',
        { className: 'ev-tabs' },
        tabs.map((t) =>
          h(
            'button',
            {
              key: t.id,
              className: 'ev-tab' + (tab === t.id ? ' ev-tab-active' : ''),
              onClick: () => setTab(t.id),
            },
            h(Icon, { d: ICONS[t.icon], size: 14 }),
            h('span', null, t.label),
            t.badge
              ? h(
                  'span',
                  { className: 'ev-tab-badge' + (t.alert ? ' ev-tab-badge-alert' : '') },
                  String(t.badge),
                )
              : null,
          ),
        ),
      );

      const content = h('div', { className: 'ev-content' }, (CONTENT[tab] || renderOverview)());

      return h(
        'div',
        { className: 'ev-scroll-shell' },
        h(
          'div',
          { className: 'ev-root' },
          header,
          nav,
          content,
          toast ? h(Toast, { message: toast.message, tone: toast.tone, onDone: () => setToast(null) }) : null,
        ),
      );
    }

    // ---------- 6. 样式表（自适应明暗主题 Token + 行号高亮 + Diff 表格）----------
    const CSS = `
.ev-brief-wrap{display:flex;flex-direction:column;gap:12px}
.ev-brief-title{margin:6px 0 0;font-size:15.5px;font-weight:680;color:var(--dsw-alias-label-primary,#f4f4f5)}
.ev-brief-section{padding:11px 14px;border-radius:10px;
  background:color-mix(in srgb,#8b7cf6 8%,var(--dsw-alias-bg-layer-2,#27272a));
  border:1px solid color-mix(in srgb,#8b7cf6 30%,transparent)}
.ev-brief-label{font-size:12px;font-weight:650;color:#ddd6fe;margin-bottom:4px}
.ev-brief-text{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary,#e4e4e7)}
.ev-brief-rules{margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px;
  font-size:12px;color:var(--dsw-alias-label-secondary,#d4d4d8)}
.ev-impact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}
.ev-impact-box{padding:10px 13px;border-radius:10px;display:flex;flex-direction:column;gap:4px}
.ev-impact-approve{background:color-mix(in srgb,#34d399 10%,transparent);
  border:1px solid color-mix(in srgb,#34d399 35%,transparent)}
.ev-impact-reject{background:color-mix(in srgb,#f87171 10%,transparent);
  border:1px solid color-mix(in srgb,#f87171 35%,transparent)}
.ev-impact-head{font-size:12px;font-weight:650}
.ev-impact-approve .ev-impact-head{color:#6ee7b7}
.ev-impact-reject .ev-impact-head{color:#fca5a5}
.ev-impact-body{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#d4d4d8)}
.ev-ai-analysis{padding:11px 14px;border-radius:10px;
  background:color-mix(in srgb,#34d399 12%,var(--dsw-alias-bg-layer-2,#27272a));
  border:1px solid color-mix(in srgb,#34d399 42%,transparent)}
.ev-directive-box{padding:12px 14px;border-radius:10px;display:flex;flex-direction:column;gap:8px;
  background:var(--dsw-alias-bg-layer-2,#27272a);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 75%,transparent)}
.ev-directive-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.ev-quick-directives{display:flex;gap:6px;flex-wrap:wrap}
.ev-textarea{resize:vertical;min-height:68px;line-height:1.55}
.ev-scroll-shell{
  height:100%; width:100%; overflow-y:auto; overflow-x:hidden; box-sizing:border-box;
}
.ev-root{
  --ev-brand:#8b7cf6; --ev-brand-soft:color-mix(in srgb,#8b7cf6 16%,transparent);
  --ev-ok:#34d399; --ev-warn:#fbbf24; --ev-err:#f87171;
  color:var(--dsw-alias-label-primary,#e4e4e7);
  font-size:13px; line-height:1.6;
  padding:22px 26px 48px;
  display:flex; flex-direction:column; gap:16px;
  max-width:1120px; margin:0 auto; min-width:0;
  font-feature-settings:"tnum" 1;
}
.ev-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;
  padding-bottom:15px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 65%,transparent)}
.ev-head-left{display:flex;gap:13px;align-items:flex-start;min-width:0;flex:1}
.ev-logo{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex-shrink:0;
  background:linear-gradient(135deg,color-mix(in srgb,#8b7cf6 30%,transparent),color-mix(in srgb,#22d3ee 18%,transparent));
  color:#c4b5fd;border:1px solid color-mix(in srgb,#8b7cf6 35%,transparent);
  box-shadow:0 2px 12px color-mix(in srgb,#8b7cf6 22%,transparent)}
.ev-title{margin:0;font-size:18.5px;font-weight:680;letter-spacing:.01em;line-height:1.25}
.ev-subtitle{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12px;line-height:1.55}
.ev-head-right{display:flex;align-items:center;gap:7px;flex-wrap:wrap}

.ev-tabs{display:flex;gap:4px;padding:4px;border-radius:12px;align-self:flex-start;flex-wrap:wrap;
  background:var(--dsw-alias-bg-layer-2,#27272a);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 75%,transparent)}
.ev-tab{display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#a1a1aa);padding:7px 13px;font-size:12.5px;font-weight:600;
  border-radius:9px;transition:all .15s ease;white-space:nowrap;font-family:inherit}
.ev-tab:hover{color:var(--dsw-alias-label-primary,#f4f4f5)}
.ev-tab-active{background:color-mix(in srgb,#8b7cf6 22%,var(--dsw-alias-bg-base,#09090b));
  color:#ddd6fe;box-shadow:0 1px 4px rgba(0,0,0,.3);border:1px solid color-mix(in srgb,#8b7cf6 42%,transparent)}
.ev-tab-badge{background:color-mix(in srgb,#8b7cf6 28%,transparent);color:#ddd6fe;
  border-radius:999px;padding:0 6px;font-size:10.5px;min-width:16px;text-align:center;line-height:16px}
.ev-tab-badge-alert{background:color-mix(in srgb,#fbbf24 32%,transparent);color:#fde68a}

.ev-content{display:flex;flex-direction:column;gap:16px;min-width:0}
.ev-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:11px}
.ev-stat{display:flex;gap:11px;align-items:flex-start;padding:14px 15px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,#18181b);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 60%,transparent);
  transition:all .15s ease}
.ev-stat-click{cursor:pointer}
.ev-stat:hover{border-color:color-mix(in srgb,#8b7cf6 42%,transparent);transform:translateY(-1px)}
.ev-stat-icon{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;flex-shrink:0;
  background:var(--ev-brand-soft);color:#c4b5fd}
.ev-stat-warn .ev-stat-icon{background:color-mix(in srgb,#fbbf24 15%,transparent);color:#fcd34d}
.ev-stat-ok .ev-stat-icon{background:color-mix(in srgb,#34d399 15%,transparent);color:#6ee7b7}
.ev-stat-value{font-size:20px;font-weight:700;line-height:1.15;letter-spacing:-.01em}
.ev-stat-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#a1a1aa);margin-top:1px}
.ev-stat-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary,#71717a);margin-top:3px;opacity:.9}

.ev-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding:11px 14px;border-radius:11px;
  background:var(--dsw-alias-bg-layer-1,#18181b);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 65%,transparent)}
.ev-banner-ok{border-left:3px solid #34d399}
.ev-banner-warn{border-left:3px solid #fbbf24}
.ev-banner-brand{border-left:3px solid #8b7cf6}
.ev-banner-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.ev-banner-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary,#a1a1aa)}

.ev-section{display:flex;flex-direction:column;gap:10px}
.ev-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ev-section-title{margin:0;font-size:13.5px;font-weight:650;letter-spacing:.01em}
.ev-section-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.ev-list{display:flex;flex-direction:column;gap:9px}

.ev-card{border-radius:12px;padding:13px 15px;display:flex;flex-direction:column;gap:10px;
  background:var(--dsw-alias-bg-layer-1,#18181b);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 60%,transparent);
  transition:border-color .15s ease}
.ev-card:hover{border-color:color-mix(in srgb,#8b7cf6 30%,transparent)}
.ev-card-draft{border-left:3px solid color-mix(in srgb,#fbbf24 70%,transparent)}
.ev-workbench{border-left:3px solid color-mix(in srgb,#8b7cf6 75%,transparent)}
.ev-card-head,.ev-row-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.ev-card-title-wrap{min-width:0;flex:1}
.ev-card-desc{color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12px;margin-top:4px}
.ev-card-actions{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap}
.ev-resources{display:flex;gap:6px;flex-wrap:wrap}

.ev-row{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;
  padding:11px 14px;border-radius:11px;
  background:var(--dsw-alias-bg-layer-1,#18181b);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 55%,transparent)}
.ev-row-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.ev-row-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.ev-row-desc{color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:11.5px;line-height:1.55}
.ev-row-meta{display:flex;align-items:center;gap:7px;flex-shrink:0;flex-wrap:wrap}
.ev-signals{display:flex;gap:5px;flex-wrap:wrap;margin-top:3px}
.ev-ts{font-size:10.5px;color:var(--dsw-alias-label-secondary,#71717a);font-variant-numeric:tabular-nums}
.ev-metric{display:inline-flex;align-items:center;gap:3px;font-size:11px;
  color:var(--dsw-alias-label-secondary,#a1a1aa)}

.ev-skill-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  color:#c4b5fd;background:var(--ev-brand-soft);padding:1px 7px;border-radius:6px}
.ev-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.ev-sha{color:#a5b4fc}

.ev-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 9px;
  font-size:10.5px;line-height:1.5;white-space:nowrap;font-weight:550;
  border:1px solid var(--dsw-alias-border-l2,#3f3f46);
  background:var(--dsw-alias-bg-layer-2,#27272a);
  color:var(--dsw-alias-label-secondary,#a1a1aa)}
.ev-chip-click{cursor:pointer}
.ev-chip-brand{color:#c4b5fd;border-color:color-mix(in srgb,#8b7cf6 40%,transparent);
  background:color-mix(in srgb,#8b7cf6 13%,transparent)}
.ev-chip-ok{color:#6ee7b7;border-color:color-mix(in srgb,#34d399 38%,transparent);
  background:color-mix(in srgb,#34d399 11%,transparent)}
.ev-chip-warn{color:#fcd34d;border-color:color-mix(in srgb,#fbbf24 38%,transparent);
  background:color-mix(in srgb,#fbbf24 11%,transparent)}
.ev-chip-idle{color:var(--dsw-alias-label-secondary,#71717a)}

.ev-btn{display:inline-flex;align-items:center;gap:5px;border-radius:8px;padding:5px 11px;
  font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,#3f3f46);
  background:var(--dsw-alias-bg-layer-2,#27272a);
  color:var(--dsw-alias-label-primary,#e4e4e7);
  transition:all .15s ease;white-space:nowrap}
.ev-btn:hover:not(:disabled){border-color:color-mix(in srgb,#8b7cf6 50%,transparent);color:#fff}
.ev-btn:disabled{opacity:.45;cursor:not-allowed}
.ev-btn-primary{background:color-mix(in srgb,#8b7cf6 24%,var(--dsw-alias-bg-layer-2,#27272a));
  border-color:color-mix(in srgb,#8b7cf6 48%,transparent);color:#ede9fe}
.ev-btn-primary:hover:not(:disabled){background:color-mix(in srgb,#8b7cf6 34%,var(--dsw-alias-bg-layer-2,#27272a))}
.ev-btn-danger{color:#fca5a5;border-color:color-mix(in srgb,#f87171 30%,transparent)}
.ev-btn-danger:hover:not(:disabled){background:color-mix(in srgb,#f87171 14%,transparent);border-color:color-mix(in srgb,#f87171 55%,transparent)}
.ev-btn-ghost{background:transparent}

.ev-icon-btn{display:grid;place-items:center;width:27px;height:27px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,#3f3f46);
  background:var(--dsw-alias-bg-layer-2,#27272a);
  color:var(--dsw-alias-label-secondary,#a1a1aa);transition:all .15s ease}
.ev-icon-btn:hover:not(:disabled){color:#fff;border-color:color-mix(in srgb,#8b7cf6 50%,transparent)}
.ev-icon-btn:disabled{opacity:.4;cursor:not-allowed}
.ev-icon-btn-on{color:#c4b5fd;border-color:color-mix(in srgb,#8b7cf6 55%,transparent);
  background:color-mix(in srgb,#8b7cf6 18%,transparent)}

/* 行号语法高亮 Markdown 预览器 */
.ev-md-viewer{border-radius:9px;overflow:hidden;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#09090b) 80%,#000);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 50%,transparent)}
.ev-fm-bar{display:flex;flex-wrap:wrap;gap:10px;padding:7px 12px;
  background:color-mix(in srgb,#8b7cf6 10%,transparent);
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 45%,transparent);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.ev-fm-item{display:inline-flex;gap:4px}
.ev-fm-key{color:#c4b5fd;font-weight:600}
.ev-fm-val{color:var(--dsw-alias-label-secondary,#d4d4d8)}
.ev-code-lines{max-height:360px;overflow:auto;padding:8px 0;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.65}
.ev-line{display:flex;padding:0 12px;min-height:1.65em}
.ev-line:hover{background:color-mix(in srgb,#8b7cf6 8%,transparent)}
.ev-line-num{width:32px;flex-shrink:0;user-select:none;text-align:right;padding-right:12px;
  color:var(--dsw-alias-label-secondary,#52525b);font-size:10.5px}
.ev-line-txt{white-space:pre-wrap;word-break:break-word;flex:1;color:var(--dsw-alias-label-primary,#e4e4e7)}
.ev-line-h1 .ev-line-txt{color:#c4b5fd;font-weight:700}
.ev-line-h2 .ev-line-txt{color:#6ee7b7;font-weight:650}
.ev-line-bullet .ev-line-txt{color:#fde68a}
.ev-line-fence .ev-line-txt{color:#93c5fd}

/* 结构化 SHA Diff 表格 */
.ev-diff-table-wrap{overflow-x:auto;border-radius:8px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 50%,transparent)}
.ev-diff-table{width:100%;border-collapse:collapse;font-size:11.5px;text-align:left}
.ev-diff-table th{padding:7px 10px;background:var(--dsw-alias-bg-layer-2,#27272a);
  color:var(--dsw-alias-label-secondary,#a1a1aa);font-weight:600;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 50%,transparent)}
.ev-diff-table td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 30%,transparent)}
.ev-diff-row-ok{background:color-mix(in srgb,#34d399 6%,transparent)}
.ev-diff-row-warn{background:color-mix(in srgb,#fbbf24 6%,transparent)}
.ev-diff-row-err{background:color-mix(in srgb,#f87171 6%,transparent)}

/* 搜索与过滤栏 */
.ev-filter-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.ev-search-wrap{display:flex;align-items:center;gap:7px;padding:5px 11px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-1,#18181b);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 65%,transparent);min-width:220px;flex:1;max-width:340px}
.ev-search-input{border:none;background:transparent;outline:none;color:var(--dsw-alias-label-primary,#e4e4e7);
  font-size:12px;width:100%;font-family:inherit}
.ev-filter-pills{display:flex;gap:5px;flex-wrap:wrap}
.ev-pill-btn{border:1px solid var(--dsw-alias-border-l2,#3f3f46);background:var(--dsw-alias-bg-layer-2,#27272a);
  color:var(--dsw-alias-label-secondary,#a1a1aa);border-radius:999px;padding:4px 11px;font-size:11px;
  font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s ease}
.ev-pill-btn-on{color:#ddd6fe;border-color:color-mix(in srgb,#8b7cf6 50%,transparent);
  background:color-mix(in srgb,#8b7cf6 20%,transparent)}

/* 建伞合并计划预览盒 */
.ev-plan-box{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border-radius:9px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#09090b) 65%,transparent);
  border:1px solid color-mix(in srgb,#8b7cf6 35%,transparent)}
.ev-plan-summary{font-size:12px;color:#ddd6fe;font-weight:550}
.ev-plan-list{display:flex;flex-direction:column;gap:5px}
.ev-plan-item{display:flex;align-items:center;gap:8px;font-size:11.5px}

.ev-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;
  padding:36px 20px;text-align:center;border-radius:12px;
  border:1px dashed color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 70%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#18181b) 55%,transparent)}
.ev-empty-icon{color:var(--dsw-alias-label-secondary,#52525b);opacity:.85}
.ev-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#a1a1aa)}
.ev-empty-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,#71717a);max-width:460px;line-height:1.6}

.ev-loading{padding:60px;text-align:center;color:var(--dsw-alias-label-secondary,#a1a1aa);font-size:12.5px}

.ev-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:9px}
.ev-flow-step{display:flex;flex-direction:column;gap:5px;padding:11px 13px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,#18181b);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 55%,transparent)}
.ev-flow-top{display:flex;align-items:center;justify-content:space-between;gap:6px}
.ev-flow-num{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;flex-shrink:0;
  font-size:10.5px;font-weight:700;background:var(--ev-brand-soft);color:#c4b5fd}
.ev-flow-title{font-size:12px;font-weight:650}
.ev-flow-desc{font-size:10.5px;color:var(--dsw-alias-label-secondary,#71717a);line-height:1.45}

.ev-settings{display:flex;flex-direction:column;gap:16px}
.ev-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.ev-field{display:flex;flex-direction:column;gap:5px}
.ev-field-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e4e4e7)}
.ev-field-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary,#71717a);line-height:1.5}
.ev-input{width:100%;box-sizing:border-box;border-radius:8px;padding:6px 10px;font-size:12px;
  font-family:inherit;color:var(--dsw-alias-label-primary,#e4e4e7);
  background:var(--dsw-alias-bg-layer-2,#27272a);
  border:1px solid var(--dsw-alias-border-l2,#3f3f46);outline:none;transition:border-color .15s ease}
.ev-input:focus{border-color:color-mix(in srgb,#8b7cf6 60%,transparent)}
.ev-settings-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding-top:13px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#3f3f46) 55%,transparent)}
.ev-settings-foot code{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:#c4b5fd}

.ev-switch{display:inline-flex;align-items:center;cursor:pointer;width:fit-content}
.ev-switch input{position:absolute;opacity:0;width:0;height:0}
.ev-switch-track{width:38px;height:21px;border-radius:999px;position:relative;display:block;
  background:var(--dsw-alias-bg-layer-2,#27272a);
  border:1px solid var(--dsw-alias-border-l2,#3f3f46);transition:all .18s ease}
.ev-switch-thumb{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
  background:var(--dsw-alias-label-secondary,#a1a1aa);transition:all .18s ease}
.ev-switch input:checked + .ev-switch-track{background:color-mix(in srgb,#8b7cf6 40%,transparent);
  border-color:color-mix(in srgb,#8b7cf6 65%,transparent)}
.ev-switch input:checked + .ev-switch-track .ev-switch-thumb{left:19px;background:#ede9fe}

.ev-toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:9999;
  display:inline-flex;align-items:center;gap:7px;padding:9px 17px;border-radius:10px;
  font-size:12px;font-weight:550;box-shadow:0 6px 24px rgba(0,0,0,.45);
  animation:ev-toast-in .2s ease;background:var(--dsw-alias-bg-overlay,#18181b);
  border:1px solid var(--dsw-alias-border-l2,#3f3f46);color:var(--dsw-alias-label-primary,#e4e4e7)}
.ev-toast-ok{border-color:color-mix(in srgb,#34d399 45%,transparent);color:#6ee7b7}
.ev-toast-err{border-color:color-mix(in srgb,#f87171 45%,transparent);color:#fca5a5}
@keyframes ev-toast-in{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}

/* 移动端与窄屏自适应（手机浏览器 / 远程连接视口） */
@media (max-width: 720px) {
  .ev-root{
    padding:14px 12px calc(36px + env(safe-area-inset-bottom,0px));
    gap:12px;
  }
  .ev-head{flex-direction:column;align-items:stretch;gap:10px;padding-bottom:12px}
  .ev-head-right{justify-content:flex-start}
  .ev-title{font-size:16.5px}
  .ev-tabs{
    width:100%; overflow-x:auto; flex-wrap:nowrap; -webkit-overflow-scrolling:touch;
    scrollbar-width:none; padding:4px;
  }
  .ev-tabs::-webkit-scrollbar{display:none}
  .ev-tab{padding:8px 12px;font-size:12.5px;flex-shrink:0}
  .ev-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .ev-stat{padding:11px 12px;gap:9px}
  .ev-stat-value{font-size:17px}
  .ev-flow{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .ev-impact-grid,.ev-settings-grid{grid-template-columns:1fr;gap:10px}
  .ev-card-head,.ev-row-head,.ev-section-head{flex-direction:column;align-items:stretch;gap:9px}
  .ev-card-actions{width:100%;flex-direction:column;gap:7px}
  .ev-card-actions .ev-btn{width:100%;justify-content:center;min-height:40px;font-size:13px}
  .ev-quick-directives{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}
  .ev-quick-directives .ev-chip{flex-shrink:0;padding:5px 11px;font-size:11.5px}
  /* 防止 iOS Safari 点击输入框时强制放大页面 */
  .ev-input,.ev-textarea,.ev-search-input{font-size:16px;padding:9px 11px}
  .ev-search-wrap{max-width:none;width:100%}
  .ev-toast{left:12px;right:12px;transform:none;bottom:calc(18px + env(safe-area-inset-bottom,0px));justify-content:center}
}
@media (max-width: 420px) {
  .ev-flow{grid-template-columns:1fr}
}
`;

    function renderWithStyles(props) {
      return h(React.Fragment, null, h('style', null, CSS), h(EvolutionPanel, props));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 1. 注册到会话顶部视图栏（与「对话 / 轨迹 / 上下文 / 编队 / 专家团」同排，紧挨专家团）
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-evolution',
              order: 41,
              label: () => '自进化',
            },
            renderWithStyles,
          ),
        );

        // 2. 同时保留设置页入口（Settings -> 自进化）
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-evolution',
              order: 30,
              label: () => '自进化',
            },
            renderWithStyles,
          ),
        );
      },
    };
  },
});
