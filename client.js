// DSH 自进化 · Web GUI 客户端（对齐 DSH 原生设置页设计语言）
//
// 视觉规范：
//   - 页面容器 max-width 720px，标题 20/500，正文 14/20，说明 12/18 secondary
//   - 设置行 padding 16px 0 + .5px 分割线，末行去边框；按钮为透明底 + .5px 描边 + 6px 圆角
//   - 颜色一律取自宿主 --dsw-alias-* token（跟随明暗主题），无自定义字体族与硬编码颜色
//   - 开关 36×20、role="switch" + aria-checked，与宿主内置开关一致
//   - 挂载位置：sidebar.panellist (order: 15) + main（完整工作台）+ settings.section（引擎参数）

window.__ModuleLoader__.load({
  id: 'skill-evolution',
  factory: (require) => {
    const React = require('react');
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;

    const API_BASE = '/dsh-evolution/api';

    async function api(endpoint, options = {}) {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return data;
    }

    // ---------- 1. 模块级单例状态中心（跨槽位同步）----------
    const EvolutionStore = {
      data: null,
      error: null,
      loading: true,
      listeners: new Set(),
      timer: null,
      inflight: null,

      notify() {
        for (const fn of this.listeners) {
          try { fn(); } catch { /* ignore */ }
        }
      },

      async fetchNow() {
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
          try {
            const res = await api('/status');
            this.data = res;
            this.error = null;
          } catch (e) {
            this.error = String(e.message || e);
          } finally {
            this.loading = false;
            this.inflight = null;
            this.notify();
          }
        })();
        return this.inflight;
      },

      subscribe(fn) {
        this.listeners.add(fn);
        if (this.listeners.size === 1) {
          this.fetchNow();
          this.timer = setInterval(() => this.fetchNow(), 6000);
        }
        return () => {
          this.listeners.delete(fn);
          if (this.listeners.size === 0 && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
          }
        };
      },
    };

    function useSnapshot() {
      const [, setTick] = useState(0);
      useEffect(() => EvolutionStore.subscribe(() => setTick((t) => t + 1)), []);
      return {
        data: EvolutionStore.data,
        error: EvolutionStore.error,
        loading: EvolutionStore.loading,
        reload: () => EvolutionStore.fetchNow(),
      };
    }

    // ---------- 2. 极简方形几何图标 ----------
    function SvgIcon({ d, size = 15 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { flexShrink: 0 },
        },
        ...(Array.isArray(d) ? d : [d]).map((p, i) => h('path', { key: i, d: p })),
      );
    }

    const ICONS = {
      refresh: ['M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16', 'M16 16h5v5'],
      check: 'M20 6 9 17l-5-5',
      spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M5.6 5.6l2.8 2.8', 'M15.6 15.6l2.8 2.8', 'M18.4 5.6l-2.8 2.8', 'M8.4 15.6l-2.8 2.8'],
      x: ['M18 6 6 18', 'M6 6l12 12'],
      undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
      pin: ['M12 17v5', 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z'],
      play: 'M6 4l14 8-14 8V4z',
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
      code: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
      arrowRight: ['M5 12h14', 'm13 6 6 6-6 6'],
    };

    // ---------- 3. 顶层受控表单组件（防重渲染失焦）----------
    function SettingField({ label, hint, children }) {
      return h(
        'div',
        { className: 'evo-field' },
        h(
          'div',
          { className: 'evo-field-main' },
          h('div', { className: 'evo-field-label' }, label),
          hint ? h('div', { className: 'evo-field-hint' }, hint) : null,
        ),
        h('div', { className: 'evo-field-control' }, children),
      );
    }

    function NativeSwitch({ checked, disabled, label, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: 'evo-switch',
          disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'evo-thumb', 'aria-hidden': 'true' }),
      );
    }

    function SettingNumberInput({ value, min, max, step = 1, onChange }) {
      const [raw, setRaw] = useState(String(value ?? ''));
      useEffect(() => {
        setRaw(String(value ?? ''));
      }, [value]);
      return h('input', {
        type: 'number',
        className: 'evo-input evo-input-num',
        min,
        max,
        step,
        value: raw,
        onChange: (e) => {
          const txt = e.target.value;
          setRaw(txt);
          const n = Number(txt);
          if (txt !== '' && !Number.isNaN(n)) onChange(n);
        },
        onBlur: () => {
          let n = Number(raw);
          if (raw === '' || Number.isNaN(n)) n = min ?? 0;
          if (min !== undefined) n = Math.max(min, n);
          if (max !== undefined) n = Math.min(max, n);
          setRaw(String(n));
          onChange(n);
        },
      });
    }

    // ---------- 4. 源码与 SHA-256 Diff 查看器（按需展开）----------
    function CodePreview({ frontmatter, body }) {
      const lines = String(body || '').split('\n');
      return h(
        'div',
        { className: 'evo-code-box' },
        frontmatter && Object.keys(frontmatter).length
          ? h(
              'div',
              { className: 'evo-code-fm' },
              Object.entries(frontmatter).map(([k, v]) =>
                h(
                  'span',
                  { key: k, className: 'evo-code-fm-item' },
                  h('strong', null, `${k}: `),
                  typeof v === 'object' ? JSON.stringify(v) : String(v),
                ),
              ),
            )
          : null,
        h(
          'pre',
          { className: 'evo-code-pre' },
          lines.map((line, i) =>
            h(
              'div',
              { key: i, className: 'evo-code-line' },
              h('span', { className: 'evo-code-num' }, String(i + 1).padStart(2, '0')),
              h('span', { className: 'evo-code-txt' }, line || ' '),
            ),
          ),
        ),
      );
    }

    function FileDiffTable({ beforeFiles = [], afterFiles = [] }) {
      const mapB = new Map((beforeFiles || []).map((f) => [f.relPath, f]));
      const mapA = new Map((afterFiles || []).map((f) => [f.relPath, f]));
      const allPaths = Array.from(new Set([...mapB.keys(), ...mapA.keys()])).sort();
      if (!allPaths.length) return h('div', { className: 'evo-field-hint' }, '无文件快照差异');

      return h(
        'table',
        { className: 'evo-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '状态'),
            h('th', null, '文件'),
            h('th', null, '修改前 SHA'),
            h('th', null, '修改后 SHA'),
            h('th', { style: { textAlign: 'right' } }, '字节'),
          ),
        ),
        h(
          'tbody',
          null,
          allPaths.map((p) => {
            const b = mapB.get(p);
            const a = mapA.get(p);
            const status = !b ? '新增' : !a ? '移除' : b.sha === a.sha ? '未变' : '修改';
            return h(
              'tr',
              { key: p },
              h('td', { className: 'evo-mono' }, status),
              h('td', { className: 'evo-mono' }, p),
              h('td', { className: 'evo-mono evo-muted' }, b ? b.sha.slice(0, 10) : '—'),
              h('td', { className: 'evo-mono' }, a ? a.sha.slice(0, 10) : '—'),
              h('td', { className: 'evo-mono', style: { textAlign: 'right' } }, a ? `${a.size}` : b ? `-${b.size}` : '0'),
            );
          }),
        ),
      );
    }

    // ---------- 5. 极简瑞士风待审草稿卡（保留全部简报、节点插想法、后果对比与批示功能）----------
    function SwissDraftCard({ draft, onRefine, onPromote, onDiscard, busyKey, defaultOpen = false }) {
      const [showSource, setShowSource] = useState(false);
      const [collapsed, setCollapsed] = useState(!defaultOpen);
      const [selectedStep, setSelectedStep] = useState(null);
      const [selectedPills, setSelectedPills] = useState([]);
      const [comment, setComment] = useState('');

      const isBusy = busyKey === `draft:${draft.name}`;
      const b = draft.briefing || {};
      const steps =
        Array.isArray(b.stepsZh) && b.stepsZh.length
          ? b.stepsZh
          : Array.isArray(b.keyRules) && b.keyRules.length
            ? b.keyRules
            : ['读取上下文并按标准顺序排查', '执行最小化修改并验证真实结果'];
      const pitfalls = Array.isArray(b.pitfallsZh) ? b.pitfallsZh : [];

      const QUICK_IDEAS = [
        { id: 'ok', label: '直接同意入库', text: '同意采纳：当前提炼的步骤与防坑规则准确，直接入库' },
        { id: 'backup', label: '+ 修改前先备份', text: '补充要求：修改任何文件或配置前必须先创建备份' },
        { id: 'readonly', label: '+ 先只读诊断', text: '补充要求：必须先通过只读命令确认根因证据再修改' },
        { id: 'concise', label: '+ 精简冗余步骤', text: '精简描述，只保留最核心的可执行命令与判断条件' },
      ];

      const togglePill = (item) => {
        setSelectedPills((prev) =>
          prev.includes(item.text) ? prev.filter((x) => x !== item.text) : [...prev, item.text],
        );
      };

      const handleStepClick = (idx, text) => {
        setSelectedStep(idx);
        const tag = `[针对步骤 0${idx + 1}（${String(text).replace(/^\d+\.\s*/, '').slice(0, 14)}…）调整]：`;
        if (!comment.includes(tag)) {
          setComment((prev) => (prev ? `${prev}；${tag}` : tag));
        }
      };

      const finalDirective = [...selectedPills, comment.trim()].filter(Boolean).join('；');

      // 折叠态：一行摘要 + 快选动作，避免一屏塞满 16 张全展开卡
      if (collapsed) {
        return h(
          'article',
          { className: 'evo-draft evo-draft-compact' },
          h(
            'div',
            { className: 'evo-compact-row' },
            h(
              'span',
              { className: 'evo-badge' + (draft.isPatch ? ' evo-badge-info' : '') },
              draft.isPatch ? '补丁草稿' : '新技能',
            ),
            h('span', { className: 'evo-compact-name' }, b.titleZh || draft.name),
            h('span', { className: 'evo-compact-sum' }, b.whatItIs || draft.description || ''),
            h(
              'div',
              { className: 'evo-compact-actions' },
              h(
                'button',
                { type: 'button', className: 'evo-link-btn', onClick: () => setCollapsed(false) },
                '展开审阅',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'evo-btn',
                  disabled: isBusy,
                  onClick: () => onPromote(draft.name, '同意采纳：按当前草稿直接入库', false),
                },
                h(SvgIcon, { d: ICONS.check, size: 14 }),
                '采纳',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'evo-btn danger',
                  disabled: isBusy,
                  onClick: () => onDiscard(draft.name, '快速驳回'),
                },
                '驳回',
              ),
            ),
          ),
        );
      }

      return h(
        'article',
        { className: 'evo-draft' },
        // 顶栏：草稿类型徽章 + 技能标识 + 源码切换
        h(
          'div',
          { className: 'evo-draft-kicker' },
          h(
            'span',
            { className: 'evo-badge' + (draft.isPatch ? ' evo-badge-info' : '') },
            draft.isPatch ? '补丁草稿' : '新技能',
          ),
          h('span', { className: 'evo-kicker evo-mono' }, draft.name),
          draft.resources?.length
            ? h('span', { className: 'evo-kicker' }, `含 ${draft.resources.length} 个引用文件`)
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'evo-link-btn',
              onClick: () => setShowSource((v) => !v),
            },
            h(SvgIcon, { d: ICONS.code, size: 13 }),
            showSource ? '返回中文简报' : '查看 SKILL.md 源码',
          ),
        ),

        // 标题与核心中文解释
        h(
          'div',
          { className: 'evo-draft-main' },
          h('h3', { className: 'evo-draft-title' }, b.titleZh || draft.name),
          h('p', { className: 'evo-draft-summary' }, b.whatItIs || draft.description || '(无摘要)'),
          b.triggerZh
            ? h(
                'div',
                { className: 'evo-trigger-line' },
                h('span', { className: 'evo-kicker' }, '触发场景'),
                h('span', null, b.triggerZh),
              )
            : null,
        ),

        // 源码视图 vs 瑞士网格简报视图
        showSource
          ? h(CodePreview, { frontmatter: draft.frontmatter, body: draft.body })
          : h(
              React.Fragment,
              null,
              // 共用 1px 细线的步骤网格（点击任一步骤即可定点插入想法）
              h(
                'div',
                { className: 'evo-steps-grid' },
                steps.slice(0, 4).map((st, idx) =>
                  h(
                    'div',
                    {
                      key: idx,
                      className: 'evo-step-cell' + (selectedStep === idx ? ' on' : ''),
                      onClick: () => handleStepClick(idx, st),
                      title: '点击针对此步骤插入您的修改想法',
                    },
                    h(
                      'div',
                      { className: 'evo-step-top' },
                      h('span', { className: 'evo-step-label' }, `步骤 ${idx + 1}`),
                      h('span', { className: 'evo-step-add' }, '+ 插入想法'),
                    ),
                    h('div', { className: 'evo-step-body' }, String(st).replace(/^\d+\.\s*/, '')),
                  ),
                ),
              ),

              // 避坑护栏（极简横条）
              pitfalls.length
                ? h(
                    'div',
                    { className: 'evo-pitfalls' },
                    h('span', { className: 'evo-kicker', style: { flex: 'none' } }, '防坑规则'),
                    h(
                      'div',
                      { className: 'evo-pitfalls-list' },
                      pitfalls.map((p, i) => h('span', { key: i, className: 'evo-pitfall-item' }, `· ${p}`)),
                    ),
                  )
                : null,

              // 同意 vs 驳回 二栏极简后果对照
              h(
                'div',
                { className: 'evo-outcomes' },
                h(
                  'div',
                  { className: 'evo-outcome-cell' },
                  h('span', { className: 'evo-kicker evo-ok-label' }, '同意后'),
                  h('p', null, b.ifApprove || '写入正式技能库并即时热更新生效，随时可通过 SHA-256 账本回滚。'),
                ),
                h(
                  'div',
                  { className: 'evo-outcome-cell' },
                  h('span', { className: 'evo-kicker' }, '驳回后'),
                  h('p', null, b.ifReject || '安全销毁该暂存草稿，正式技能库保持 0 改动。'),
                ),
              ),
            ),

        // AI 上次修订汇报（如有）
        b.aiAnalysis
          ? h(
              'div',
              { className: 'evo-ai-note' },
              h('span', { className: 'evo-kicker' }, 'AI 修订说明'),
              h('span', null, b.aiAnalysis),
            )
          : null,

        // 底部单行极简批示与操作栏
        h(
          'div',
          { className: 'evo-draft-foot' },
          h(
            'div',
            { className: 'evo-pills-row' },
            h('span', { className: 'evo-kicker', style: { flex: 'none' } }, '审阅批示'),
            QUICK_IDEAS.map((item) => {
              const active = selectedPills.includes(item.text);
              return h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'evo-pill',
                  'aria-pressed': active ? 'true' : 'false',
                  onClick: () => togglePill(item),
                },
                item.label,
              );
            }),
          ),
          h(
            'div',
            { className: 'evo-action-row' },
            h('input', {
              type: 'text',
              className: 'evo-input evo-directive-input',
              placeholder: '输入您的批示或想法（必填：可点选上方快捷胶囊或点击步骤格子定点插入）…',
              value: comment,
              onChange: (e) => setComment(e.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'evo-btn ghost',
                disabled: isBusy || !finalDirective,
                onClick: () => onRefine(draft.name, finalDirective),
                title: '让 AI 先按您的想法修改草稿并预览',
              },
              isBusy ? '处理中…' : 'AI 微调预览',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'evo-btn primary',
                disabled: isBusy || !finalDirective,
                onClick: () =>
                  onPromote(
                    draft.name,
                    finalDirective,
                    Boolean(comment.trim() || selectedPills.some((x) => !x.startsWith('同意采纳：当前'))),
                  ),
              },
              h(SvgIcon, { d: ICONS.check, size: 13 }),
              isBusy ? '入库中…' : '采纳并入库',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'evo-btn ghost danger',
                disabled: isBusy,
                onClick: () => onDiscard(draft.name, finalDirective || '人工审阅驳回'),
              },
              h(SvgIcon, { d: ICONS.x, size: 13 }),
              '驳回',
            ),
          ),
        ),
      );
    }

    // ---------- 6. 正式技能行与账本行 ----------
    function SwissSkillRow({ skill, onPin, onDisown, busyKey }) {
      const [open, setOpen] = useState(false);
      const [detail, setDetail] = useState(null);
      const isBusy = busyKey === `skill:${skill.name}`;

      const toggleOpen = async () => {
        if (open) {
          setOpen(false);
          return;
        }
        setOpen(true);
        if (!detail) {
          try {
            const r = await api(`/skill/${encodeURIComponent(skill.name)}`);
            setDetail(r.skill);
          } catch { /* ignore */ }
        }
      };

      const stateLabel =
        { active: '活跃', stale: '陈旧', archived: '归档' }[skill.state] || skill.state || '活跃';

      return h(
        'div',
        { className: 'evo-row-card' },
        h(
          'div',
          { className: 'evo-row-line' },
          h(
            'div',
            { className: 'evo-row-main' },
            h(
              'div',
              { className: 'evo-row-title-line' },
              h('button', { type: 'button', className: 'evo-row-name', onClick: toggleOpen }, skill.name),
              h('span', { className: 'evo-badge' }, stateLabel),
              skill.pinned ? h('span', { className: 'evo-badge' }, '已固定') : null,
              h('span', { className: 'evo-row-meta' }, `使用 ${skill.useCount || 0} 次`),
            ),
            h('span', { className: 'evo-row-desc' }, skill.description || '—'),
          ),
          h(
            'div',
            { className: 'evo-row-end' },
            h(
              'button',
              {
                type: 'button',
                className: 'evo-ibtn' + (skill.pinned ? ' on' : ''),
                disabled: isBusy,
                title: skill.pinned ? '取消固定' : '固定技能（豁免自动归档与合并）',
                'aria-label': skill.pinned ? '取消固定' : '固定技能',
                onClick: () => onPin(skill.name, !skill.pinned),
              },
              h(SvgIcon, { d: ICONS.pin, size: 14 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'evo-link-btn',
                onClick: toggleOpen,
              },
              open ? '收起' : '详情',
            ),
            skill.createdBy === 'agent'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'evo-link-btn',
                    disabled: isBusy,
                    onClick: () => onDisown(skill.name),
                  },
                  '脱离',
                )
              : null,
          ),
        ),
        open && detail
          ? h(
              'div',
              { className: 'evo-drawer' },
              h(CodePreview, { frontmatter: detail.frontmatter, body: detail.body }),
            )
          : null,
      );
    }

    function SwissLedgerRow({ entry, onRollback, busyKey }) {
      const [open, setOpen] = useState(false);
      const isBusy = busyKey === `rb:${entry.id}`;
      const ts = entry.ts ? new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }) : '';
      const canRollback =
        entry.action !== 'rollback' &&
        entry.action !== 'draft_discard' &&
        !String(entry.action || '').startsWith('draft_');

      const actionLabel =
        {
          promote: '入库',
          rollback: '回滚',
          draft_discard: '驳回草稿',
          draft_add_reference: '新增引用',
          draft_update: '更新草稿',
          adopt: '纳管',
          pin: '固定',
          disown: '脱离',
          consolidate: '建伞合并',
          tidy: '整理',
        }[entry.action] || String(entry.action || '').toUpperCase();

      return h(
        'div',
        { className: 'evo-row-card' },
        h(
          'div',
          { className: 'evo-row-line' },
          h(
            'div',
            { className: 'evo-row-main' },
            h(
              'div',
              { className: 'evo-row-title-line' },
              h('span', { className: 'evo-row-meta' }, actionLabel),
              h('span', { className: 'evo-row-name' }, entry.target),
              h('span', { className: 'evo-mono evo-muted' }, entry.id.slice(0, 8)),
            ),
            h(
              'span',
              { className: 'evo-row-desc' },
              entry.extra?.userComment
                ? `批示：${entry.extra.userComment}`
                : entry.extra?.rationale || `${entry.beforeFiles || 0} → ${entry.afterFiles || 0} 个文件`,
            ),
          ),
          h(
            'div',
            { className: 'evo-row-end' },
            h('span', { className: 'evo-row-meta' }, ts),
            h(
              'button',
              { type: 'button', className: 'evo-link-btn', onClick: () => setOpen((v) => !v) },
              open ? '收起' : 'SHA 差异',
            ),
            canRollback
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'evo-btn',
                    disabled: isBusy,
                    onClick: () => onRollback(entry.id, entry.target),
                  },
                  h(SvgIcon, { d: ICONS.undo, size: 14 }),
                  isBusy ? '回滚中…' : '回滚',
                )
              : null,
          ),
        ),
        open
          ? h(
              'div',
              { className: 'evo-drawer' },
              h(FileDiffTable, {
                beforeFiles: entry.before?.files || [],
                afterFiles: entry.after?.files || [],
              }),
            )
          : null,
      );
    }

    // ---------- 7. 设置面板 ----------
    function SwissSettingsPanel({ config, onSave, busyKey }) {
      const [draft, setDraft] = useState(config);
      const [dirty, setDirty] = useState(false);

      useEffect(() => {
        setDraft(config);
        setDirty(false);
      }, [
        config.enabled,
        config.mode,
        config.minTurnsBetween,
        config.minMinutesBetween,
        config.maxMessages,
        config.maxChars,
        config.reviewTimeoutSeconds,
        config.curatorEnabled,
        config.consolidate,
        config.consolidateDryRun,
        config.staleAfterDays,
        config.archiveAfterDays,
        config.reviewModel?.model,
      ]);

      const set = (k, v) => {
        setDraft((prev) => ({ ...prev, [k]: v }));
        setDirty(true);
      };

      const isBusy = busyKey === 'save-config';

      return h(
        'div',
        { className: 'evo-settings-box' },
        h(
          'div',
          { className: 'evo-settings-grid' },
          h(
            SettingField,
            { label: '启用后台复盘采集', hint: '每个有效会话回合结束后自动提取可复用经验' },
            h(NativeSwitch, {
              checked: Boolean(draft.enabled),
              label: '启用后台复盘采集',
              onChange: (v) => set('enabled', v),
            }),
          ),
          h(
            SettingField,
            { label: '落盘模式', hint: '草稿审阅先写入暂存区等待批示；直接落盘通过安全闸门后立即生效' },
            h(
              'div',
              { className: 'evo-pills-row' },
              [
                ['draft', '草稿审阅'],
                ['apply', '直接落盘'],
              ].map(([k, label]) =>
                h(
                  'button',
                  {
                    key: k,
                    type: 'button',
                    className: 'evo-pill',
                    'aria-pressed': draft.mode === k ? 'true' : 'false',
                    onClick: () => set('mode', k),
                  },
                  label,
                ),
              ),
            ),
          ),
          h(
            SettingField,
            { label: '复盘回合间隔', hint: '建议设为 1，避免高价值回合被节流跳过' },
            h(SettingNumberInput, {
              value: draft.minTurnsBetween,
              min: 1,
              max: 50,
              onChange: (v) => set('minTurnsBetween', v),
            }),
          ),
          h(
            SettingField,
            { label: '复盘时间防抖（分钟）', hint: '两次后台复盘之间的最短间隔分钟数' },
            h(SettingNumberInput, {
              value: draft.minMinutesBetween,
              min: 0,
              max: 1440,
              onChange: (v) => set('minMinutesBetween', v),
            }),
          ),
          h(
            SettingField,
            { label: '快照保留消息数', hint: '送入复盘模型的最近原文消息数，更早消息自动折叠为摘要' },
            h(SettingNumberInput, {
              value: draft.maxMessages,
              min: 4,
              max: 200,
              onChange: (v) => set('maxMessages', v),
            }),
          ),
          h(
            SettingField,
            { label: '快照字符上限', hint: '单次复盘最大上下文字符预算' },
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
            { label: '陈旧 / 归档天数阈值', hint: '默认 14 天标记为陈旧，30 天归入 .archive（永不删除）' },
            h(
              'div',
              { className: 'evo-inline-fields' },
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
          h(
            SettingField,
            { label: '复盘专用模型', hint: '留空继承当前会话模型；也可填更便宜的辅助模型以省主模型配额' },
            h('input', {
              type: 'text',
              className: 'evo-input evo-input-wide',
              placeholder: 'provider/model（留空继承会话模型）',
              value: draft.reviewModel?.model || '',
              onChange: (e) =>
                set('reviewModel', { ...(draft.reviewModel || {}), model: e.target.value }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'evo-settings-foot' },
          h('span', { className: 'evo-kicker' }, `技能目录：${config.skillsRoot || '~/.dsh/skills'}`),
          h(
            'button',
            {
              type: 'button',
              className: 'evo-btn primary',
              disabled: !dirty || isBusy,
              onClick: () => onSave(draft),
            },
            h(SvgIcon, { d: ICONS.check, size: 14 }),
            isBusy ? '保存中…' : dirty ? '保存' : '已同步',
          ),
        ),
      );
    }

    // ---------- 8. 主工作台（歸藏瑞士国际主义左栏 + 右主区架构）----------
    function EvolutionPanel({ variant = 'page' }) {
      const { data, error, loading, reload } = useSnapshot();
      const [view, setView] = useState('home'); // home | drafts | skills | ledger | settings
      const [busyKey, setBusyKey] = useState(null);
      const [toast, setToast] = useState(null);
      const [skillQuery, setSkillQuery] = useState('');
      const [skillFilter, setSkillFilter] = useState('all');
      const [consolidationPlan, setConsolidationPlan] = useState(null);
      const [tidyPlan, setTidyPlan] = useState(null);

      useEffect(() => {
        if (!toast) return undefined;
        const t = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(t);
      }, [toast]);

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
        return h('div', { className: 'evo-page' }, h('div', { className: 'evo-loading' }, '正在加载自进化数据…'));
      }
      if (error && !data) {
        return h(
          'div',
          { className: 'evo-loading' },
          h('div', null, `连接失败：${error}`),
          h(
            'button',
            { type: 'button', className: 'evo-btn', style: { marginTop: '12px' }, onClick: () => reload() },
            '重试连接',
          ),
        );
      }

      const stats = data?.stats ?? { skills: 0, agentCreated: 0, drafts: 0, ledger: 0, byState: {} };
      const config = data?.config ?? {};
      const drafts = data?.drafts ?? [];
      const skills = data?.skills ?? [];
      const ledger = data?.recentLedger ?? [];
      const unmanaged = data?.unmanaged ?? [];
      const lastReview = data?.lastReview ?? null;

      const handleManualReview = () =>
        act(
          'manual-review',
          () => api('/review', { method: 'POST', body: '{}' }),
          (r) =>
            r?.result?.target
              ? `复盘完成：已生成「${r.result.target}」`
              : `复盘完成：${r?.result?.action || '当前会话无新技能信号'}`,
        );

      const handleRefine = (name, comment) =>
        act(
          `draft:${name}`,
          () => api('/refine-draft', { method: 'POST', body: JSON.stringify({ name, comment }) }),
          (r) => `AI 已按您的批示修订「${name}」：${r?.aiAnalysis || ''}`,
        );

      const handlePromote = (name, comment, evolveWithComment = false) =>
        act(
          `draft:${name}`,
          () => api('/promote', { method: 'POST', body: JSON.stringify({ name, comment, evolveWithComment }) }),
          `已采纳「${name}」进入正式技能库`,
        );

      const handleDiscard = (name, comment) =>
        act(
          `draft:${name}`,
          () => api('/discard', { method: 'POST', body: JSON.stringify({ name, comment }) }),
          `已驳回并销毁草稿「${name}」`,
        );

      const handleTidyPreview = () =>
        act(
          'tidy-preview',
          async () => {
            const r = await api('/tidy', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
            setTidyPlan(r.plan);
            return r;
          },
          (r) => {
            const s = r?.plan?.summary || {};
            return `整理方案：自动升级 ${s.autoPromote || 0} 份、自动归档 ${(s.corrupt || 0) + (s.autoDrop || 0)} 份、仅 ${s.groupsNeedingDecision || 0} 组需你决策`;
          },
        );

      const handleTidyApply = () =>
        act(
          'tidy-apply',
          async () => {
            const r = await api('/tidy', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
            setTidyPlan(r.plan);
            return r;
          },
          (r) => `已整理：${(r?.done || []).length} 项机械动作完成（全部记入 SHA-256 账本可回滚）`,
        );

      const handlePromoteBatch = () =>
        act(
          'promote-batch',
          () => api('/promote-batch', { method: 'POST', body: JSON.stringify({ comment: '一键批量审阅采纳' }) }),
          (r) => `已一次性批量采纳 ${(r?.promoted || []).length} 个草稿（单次目录刷新）`,
        );

      const handlePreviewConsolidate = () =>
        act(
          'consolidate-preview',
          async () => {
            const r = await api('/consolidate', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
            setConsolidationPlan(r);
            return r;
          },
          (r) => (r?.skipped ? `建伞分析：${r.reason}` : `已生成 ${(r?.planned || []).length} 项建伞合并预览`),
        );

      const handleApplyConsolidate = () =>
        act(
          'consolidate-apply',
          async () => {
            const r = await api('/consolidate', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
            setConsolidationPlan(r);
            return r;
          },
          (r) => `已执行建伞合并：${(r?.done || []).length} 项变更已记入账本`,
        );

      const heartbeatText = lastReview?.ts
        ? new Date(lastReview.ts).toLocaleTimeString('zh-CN', { hour12: false })
        : 'READY';
      const heartbeatSub = lastReview?.lastSaved?.target
        ? `最近产出: ${lastReview.lastSaved.target}`
        : lastReview?.target
          ? `最近产出: ${lastReview.target}`
          : lastReview?.status
            ? `状态: ${lastReview.status.toUpperCase()}`
            : '监听回合中';

      const filteredSkills = skills.filter((s) => {
        if (skillFilter === 'agent' && s.createdBy !== 'agent') return false;
        if (skillFilter === 'active' && s.state !== 'active') return false;
        if (skillFilter === 'stale' && s.state !== 'stale') return false;
        if (skillFilter === 'archived' && s.state !== 'archived') return false;
        if (skillQuery.trim()) {
          const q = skillQuery.trim().toLowerCase();
          return (
            s.name.toLowerCase().includes(q) ||
            String(s.description || '').toLowerCase().includes(q)
          );
        }
        return true;
      });

      const TABS = [
        ['home', '概览'],
        ['drafts', '待审草稿', stats.drafts],
        ['skills', '技能库', stats.skills],
        ['ledger', '账本', stats.ledger],
        ['settings', '参数'],
      ];

      // 设置页插槽：只保留原生设置页该有的内容（参数 + 状态），审阅工作台在侧栏面板
      if (variant === 'settings') {
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'evo-page evo-page-settings' },
            h(
              'div',
              { className: 'evo-page-inner' },
              h(
                'header',
                { className: 'evo-page-head' },
                h(
                  'div',
                  null,
                  h('h1', { className: 'evo-page-title' }, '自进化'),
                  h(
                    'p',
                    { className: 'evo-page-lead' },
                    '回合结束后自动复盘会话，把可复用流程与防坑规则蒸馏成技能草稿；审阅与入库在侧栏「自进化」中完成。',
                  ),
                ),
              ),
              h(SwissSettingsPanel, {
                config,
                busyKey,
                onSave: (next) =>
                  act(
                    'save-config',
                    () => api('/config', { method: 'POST', body: JSON.stringify(next) }),
                    '配置已保存并同步至内存节流器',
                  ),
              }),
            ),
          ),
          toast
            ? h(
                'div',
                { className: 'evo-toast' + (toast.tone === 'err' ? ' err' : '') },
                h('span', { className: 'evo-kicker' }, toast.tone === 'err' ? '错误' : '完成'),
                h('span', null, toast.message),
              )
            : null,
        );
      }

      return h(
        'div',
        { className: 'evo-page' },
        h(
          'div',
          { className: 'evo-page-inner' },
          h(
            'header',
            { className: 'evo-page-head' },
            h(
              'div',
              null,
              h('h1', { className: 'evo-page-title' }, '自进化'),
              h(
                'p',
                { className: 'evo-page-lead' },
                '回合结束后自动提取可复用流程与防坑规则。打开草稿可查看中文简报、点击步骤插入想法，或直接采纳进正式技能库。',
              ),
            ),
            h(
              'div',
              { className: 'evo-head-actions' },
              drafts.length > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'evo-btn',
                      disabled: busyKey === 'tidy-preview' || busyKey === 'tidy-apply',
                      onClick: handleTidyPreview,
                      title: '先出方案：自动升级同名补丁、自动归档垃圾草稿，只把真正需要你决策的留下来',
                    },
                    h(SvgIcon, { d: ICONS.spark, size: 14 }),
                    busyKey === 'tidy-preview' ? '正在分析…' : `一键整理 (${drafts.length})`,
                  )
                : null,
              drafts.length > 1
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'evo-btn',
                      disabled: busyKey === 'promote-batch',
                      onClick: handlePromoteBatch,
                    },
                    h(SvgIcon, { d: ICONS.check, size: 14 }),
                    busyKey === 'promote-batch' ? '批量入库中…' : `全部采纳 (${drafts.length})`,
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'evo-btn',
                  onClick: () => reload(),
                },
                h(SvgIcon, { d: ICONS.refresh, size: 14 }),
                '刷新',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'evo-btn primary',
                  disabled: busyKey === 'manual-review',
                  onClick: handleManualReview,
                },
                h(SvgIcon, { d: ICONS.play, size: 13 }),
                busyKey === 'manual-review' ? '正在复盘当前会话…' : '立即复盘当前会话',
              ),
            ),
          ),

          // 原生分段标签页
          h(
            'nav',
            { className: 'evo-tabs', role: 'tablist', 'aria-label': '自进化视图' },
            TABS.map(([id, label, count]) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  role: 'tab',
                  className: 'evo-tab',
                  'aria-selected': view === id ? 'true' : 'false',
                  onClick: () => setView(id),
                },
                label,
                count !== null && count !== undefined
                  ? h('span', { className: 'evo-tab-count' }, String(count))
                  : null,
              ),
            ),
          ),

          // 概览统计（原生行式，无自造卡片）
          h(
            'div',
            { className: 'evo-stats' },
            h(
              'div',
              { className: 'evo-stat', onClick: () => setView('drafts') },
              h('div', { className: 'evo-stat-label' }, '待审草稿'),
              h('div', { className: 'evo-stat-val' }, String(stats.drafts)),
              h('div', { className: 'evo-stat-sub' }, stats.drafts ? '等待您批示审阅' : '暂存区已清空'),
            ),
            h(
              'div',
              { className: 'evo-stat', onClick: () => setView('skills') },
              h('div', { className: 'evo-stat-label' }, '正式技能'),
              h('div', { className: 'evo-stat-val' }, String(stats.skills)),
              h('div', { className: 'evo-stat-sub' }, `活跃 ${stats.byState?.active || 0} · 陈旧 ${stats.byState?.stale || 0}`),
            ),
            h(
              'div',
              { className: 'evo-stat', onClick: () => setView('ledger') },
              h('div', { className: 'evo-stat-label' }, '账本快照'),
              h('div', { className: 'evo-stat-val' }, String(stats.ledger)),
              h('div', { className: 'evo-stat-sub' }, '内容寻址 · 可随时回滚'),
            ),
            h(
              'div',
              { className: 'evo-stat', onClick: () => setView('settings') },
              h('div', { className: 'evo-stat-label' }, '最近心跳'),
              h('div', { className: 'evo-stat-val' }, heartbeatText),
              h('div', { className: 'evo-stat-sub' }, heartbeatSub),
            ),
          ),
          h(
            'p',
            { className: 'evo-meta' },
            `模式 ${(config.mode || 'draft') === 'apply' ? '直接落盘' : '草稿审阅'} · 节流 ${config.minTurnsBetween || 1} 回合 / ${config.minMinutesBetween || 2} 分钟 · 心跳 ${heartbeatText}`,
          ),

          // 视图 1 & 2：概览 / 待审草稿
          view === 'home' || view === 'drafts'
            ? h(
                React.Fragment,
                null,
                h(
                  'section',
                  { className: 'evo-sec' },
                  h(
                    'div',
                    { className: 'evo-sec-head' },
                    h('h2', { className: 'evo-sec-title' }, '待审阅技能草稿'),
                    h('span', { className: 'evo-count' }, String(drafts.length)),
                    drafts.length > 0
                      ? h(
                          'span',
                          { className: 'evo-kicker', style: { marginLeft: 'auto' } },
                          '点击步骤可插入想法',
                        )
                      : null,
                  ),
                  tidyPlan
                    ? h(
                        'div',
                        { className: 'evo-tidy-box' },
                        h(
                          'div',
                          { className: 'evo-tidy-head' },
                          h('span', { className: 'evo-ink' }, '整理方案'),
                          h(
                            'span',
                            { className: 'evo-tidy-stats' },
                            h('span', null, `自动升级补丁 ${tidyPlan.summary?.autoPromote || 0}`),
                            h('span', { className: 'evo-sep' }, '/'),
                            h('span', null, `自动归档垃圾 ${(tidyPlan.summary?.corrupt || 0) + (tidyPlan.summary?.autoDrop || 0)}`),
                            h('span', { className: 'evo-sep' }, '/'),
                            h('span', { className: 'evo-accent' }, `需你决策 ${tidyPlan.summary?.groupsNeedingDecision || 0} 组`),
                          ),
                          h(
                            'div',
                            { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
                            h(
                              'button',
                              { type: 'button', className: 'evo-btn ghost', onClick: () => setTidyPlan(null) },
                              '收起',
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'evo-btn',
                                disabled: busyKey === 'tidy-apply',
                                onClick: handleTidyApply,
                              },
                              h(SvgIcon, { d: ICONS.check, size: 13 }),
                              busyKey === 'tidy-apply' ? '执行中…' : '执行机械部分',
                            ),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'evo-tidy-grid' },
                          (tidyPlan.autoPromote || []).length
                            ? h(
                                'div',
                                { className: 'evo-tidy-cell' },
                                h('div', { className: 'evo-kicker evo-ok-label' }, '自动升级（可回滚）'),
                                tidyPlan.autoPromote.map((c) =>
                                  h('div', { key: c.name, className: 'evo-tidy-item' }, `· ${c.name} → ${c.anchor}`),
                                ),
                              )
                            : null,
                          (tidyPlan.corrupt || []).length + (tidyPlan.autoDrop || []).length
                            ? h(
                                'div',
                                { className: 'evo-tidy-cell' },
                                h('div', { className: 'evo-kicker' }, '自动归入 .archive（不删除）'),
                                [...(tidyPlan.corrupt || []), ...(tidyPlan.autoDrop || [])].map((c) =>
                                  h('div', { key: c.name, className: 'evo-tidy-item' }, `· ${c.name}`),
                                ),
                              )
                            : null,
                          (tidyPlan.groups || []).length
                            ? h(
                                'div',
                                { className: 'evo-tidy-cell evo-tidy-cell-wide' },
                                h('div', { className: 'evo-kicker evo-accent' }, '需要你拍板的分组'),
                                tidyPlan.groups.map((g) =>
                                  h(
                                    'div',
                                    { key: g.theme, className: 'evo-tidy-group' },
                                    h(
                                      'div',
                                      { className: 'evo-tidy-group-head' },
                                      h('span', { className: 'evo-tidy-group-name' }, g.theme),
                                      h(
                                        'span',
                                        { className: 'evo-kicker ' + (g.suggestion === 'merge' ? 'evo-accent' : 'evo-muted') },
                                        g.suggestion === 'merge' ? `建议合并 ${g.members.length} 份` : '可单独采纳',
                                      ),
                                    ),
                                    h(
                                      'div',
                                      { className: 'evo-tidy-members' },
                                      g.members.map((m) =>
                                        h(
                                          'button',
                                          {
                                            key: m,
                                            type: 'button',
                                            className: 'evo-pill',
                                            onClick: () =>
                                              act(
                                                `draft:${m}`,
                                                () =>
                                                  api('/promote', {
                                                    method: 'POST',
                                                    body: JSON.stringify({ name: m, comment: '一键整理：采纳', evolveWithComment: false }),
                                                  }),
                                                `已采纳「${m}」`,
                                              ),
                                          },
                                          m,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              )
                            : null,
                        ),
                      )
                    : null,
                  drafts.length
                    ? h(
                        'div',
                        { className: 'evo-draft-list' },
                        drafts.map((d) =>
                          h(SwissDraftCard, {
                            key: d.name,
                            draft: d,
                            busyKey,
                            onRefine: handleRefine,
                            onPromote: handlePromote,
                            onDiscard: handleDiscard,
                          }),
                        ),
                      )
                    : h(
                        'div',
                        { className: 'evo-empty' },
                        h('div', { className: 'evo-ink' }, '暂无待审草稿'),
                        h('p', null, '当前没有待审阅的技能草稿。点击右上角「立即复盘当前会话」可随时提取新草稿。'),
                      ),
                ),
                view === 'home'
                  ? h(
                      'section',
                      { className: 'evo-sec' },
                      h(
                        'div',
                        { className: 'evo-sec-head' },
                        h('h2', { className: 'evo-sec-title' }, '最近账本变动'),
                        h(
                          'button',
                          { type: 'button', className: 'evo-more', onClick: () => setView('ledger') },
                          '查看全部账本',
                          h(SvgIcon, { d: ICONS.arrowRight, size: 13 }),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'evo-list' },
                        ledger.slice(0, 5).map((e) =>
                          h(SwissLedgerRow, {
                            key: e.id,
                            entry: e,
                            busyKey,
                            onRollback: (id, target) =>
                              act(
                                `rb:${id}`,
                                () => api('/rollback', { method: 'POST', body: JSON.stringify({ id }) }),
                                `已回滚「${target}」`,
                              ),
                          }),
                        ),
                      ),
                    )
                  : null,
              )
            : null,

          // 视图 3：正式技能与建伞合并
          view === 'skills'
            ? h(
                React.Fragment,
                null,
                h(
                  'section',
                  { className: 'evo-sec' },
                  h(
                    'div',
                    { className: 'evo-sec-head' },
                    h('h2', { className: 'evo-sec-title' }, '合并为大伞技能'),
                    h(
                      'div',
                      { className: 'evo-sec-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'evo-btn ghost',
                          disabled: busyKey === 'consolidate-preview',
                          onClick: handlePreviewConsolidate,
                        },
                        busyKey === 'consolidate-preview' ? '分析中…' : '预览合并计划 (Dry-Run)',
                      ),
                      consolidationPlan?.planned?.length
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'evo-btn',
                              disabled: busyKey === 'consolidate-apply',
                              onClick: handleApplyConsolidate,
                            },
                            busyKey === 'consolidate-apply' ? '执行中…' : '确认执行合并',
                          )
                        : null,
                    ),
                  ),
                  consolidationPlan
                    ? h(
                        'div',
                        { className: 'evo-plan-box' },
                        h(
                          'div',
                          { className: 'evo-mono' },
                          consolidationPlan.skipped
                            ? `已跳过：${consolidationPlan.reason}`
                            : consolidationPlan.summary || `计划操作：${(consolidationPlan.planned || []).length} 项`,
                        ),
                        (consolidationPlan.planned || []).map((p, i) =>
                          h('div', { key: i, className: 'evo-mono evo-muted' }, `· ${p}`),
                        ),
                      )
                    : h(
                        'p',
                        { className: 'evo-field-hint' },
                        '将多个重叠的窄技能蒸馏合并为高内聚「类级别大伞技能」，减少目录行数并提升路由准确度（被吸收的旧技能自动归入 .archive 并记入 SHA-256 账本）。',
                      ),
                ),

                h(
                  'section',
                  { className: 'evo-sec' },
                  h(
                    'div',
                    { className: 'evo-sec-head' },
                    h('h2', { className: 'evo-sec-title' }, '正式技能库'),
                    h('span', { className: 'evo-count' }, String(filteredSkills.length)),
                  ),
                  h(
                    'div',
                    { className: 'evo-toolbar' },
                    h(
                      'div',
                      { className: 'evo-search' },
                      h(SvgIcon, { d: ICONS.search, size: 14 }),
                      h('input', {
                        type: 'text',
                        placeholder: '搜索技能名称或描述…',
                        value: skillQuery,
                        onChange: (e) => setSkillQuery(e.target.value),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'evo-pills-row', style: { marginLeft: 'auto' } },
                      [
                        ['all', `全部 (${skills.length})`],
                        ['active', `活跃 (${stats.byState?.active || 0})`],
                        ['stale', `陈旧 (${stats.byState?.stale || 0})`],
                        ['archived', `归档 (${stats.byState?.archived || 0})`],
                      ].map(([id, label]) =>
                        h(
                          'button',
                          {
                            key: id,
                            type: 'button',
                            className: 'evo-pill',
                            'aria-pressed': skillFilter === id ? 'true' : 'false',
                            onClick: () => setSkillFilter(id),
                          },
                          label,
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'evo-list' },
                    filteredSkills.map((s) =>
                      h(SwissSkillRow, {
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
                            `已脱离「${name}」`,
                          ),
                      }),
                    ),
                  ),
                ),

                unmanaged.length
                  ? h(
                      'section',
                      { className: 'evo-sec' },
                      h(
                        'div',
                        { className: 'evo-sec-head' },
                        h('h2', { className: 'evo-sec-title' }, '外部 / 手写未纳管技能'),
                        h('span', { className: 'evo-count' }, String(unmanaged.length)),
                      ),
                      h(
                        'div',
                        { className: 'evo-list' },
                        unmanaged.map((name) =>
                          h(
                            'div',
                            { key: name, className: 'evo-row-card' },
                            h(
                              'div',
                              { className: 'evo-row-line' },
                              h(
                                'div',
                                { className: 'evo-row-main' },
                                h(
                                  'div',
                                  { className: 'evo-row-title-line' },
                                  h('span', { className: 'evo-row-name' }, name),
                                  h('span', { className: 'evo-badge' }, '未纳管'),
                                ),
                                h('span', { className: 'evo-row-desc' }, '用户手写或外部导入（默认受保护，不自动修改）'),
                              ),
                              h(
                                'div',
                                { className: 'evo-row-end' },
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    className: 'evo-btn',
                                    onClick: () =>
                                      act(
                                        `adopt:${name}`,
                                        () => api('/adopt', { method: 'POST', body: JSON.stringify({ name }) }),
                                        `已纳管「${name}」`,
                                      ),
                                  },
                                  '纳入统计',
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    )
                  : null,
              )
            : null,

          // 视图 4：SHA-256 账本
          view === 'ledger'
            ? h(
                'section',
                { className: 'evo-sec' },
                h(
                  'div',
                  { className: 'evo-sec-head' },
                  h('h2', { className: 'evo-sec-title' }, 'SHA-256 内容寻址账本'),
                  h('span', { className: 'evo-count' }, String(ledger.length)),
                  h('span', { className: 'evo-kicker', style: { marginLeft: 'auto' } }, '.evolution_ledger.jsonl'),
                ),
                h(
                  'div',
                  { className: 'evo-list' },
                  ledger.map((e) =>
                    h(SwissLedgerRow, {
                      key: e.id,
                      entry: e,
                      busyKey,
                      onRollback: (id, target) =>
                        act(
                          `rb:${id}`,
                          () => api('/rollback', { method: 'POST', body: JSON.stringify({ id }) }),
                          `已回滚「${target}」`,
                        ),
                    }),
                  ),
                ),
              )
            : null,

          // 视图 5：引擎配置
          view === 'settings'
            ? h(
                'section',
                { className: 'evo-sec' },
                h(
                  'div',
                  { className: 'evo-sec-head' },
                  h('h2', { className: 'evo-sec-title' }, '引擎与节流参数'),
                ),
                h(SwissSettingsPanel, {
                  config,
                  busyKey,
                  onSave: (next) =>
                    act(
                      'save-config',
                      () => api('/config', { method: 'POST', body: JSON.stringify(next) }),
                      '配置已保存并同步至内存节流器',
                    ),
                }),
              )
            : null,
        ),

        toast
          ? h(
              'div',
              { className: 'evo-toast' + (toast.tone === 'err' ? ' err' : '') },
              h('span', { className: 'evo-kicker' }, toast.tone === 'err' ? '错误' : '完成'),
              h('span', null, toast.message),
            )
          : null,
      );
    }

    // ---------- 9. 原生样式表（对齐 DSH 设置页：720px 容器 / 20·14·12 字号阶梯 / .5px 行线 / token 取色）----------
    const CSS = `
.evo-page {
  --evo-radius-sm: var(--dsw-radius-sm, 6px);
  --evo-radius-md: var(--dsw-radius-md, 8px);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
  padding: 0 clamp(24px, 4vw, 48px);
  -webkit-font-smoothing: antialiased;
}
.evo-page *, .evo-page *::before, .evo-page *::after { box-sizing: border-box; }
.evo-page-inner {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 28px 0 64px;
}
.evo-page-settings { height: auto; overflow: visible; padding: 0; }
.evo-page-settings .evo-page-inner { gap: 16px; padding: 4px 0 24px; }

/* 页头 */
.evo-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.evo-page-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; color: var(--dsw-alias-label-primary); }
.evo-page-lead { margin: 4px 0 0; max-width: 60ch; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.evo-head-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.evo-meta { margin: -8px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

/* 分段标签页（原生 SegmentedTabs 观感） */
.evo-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  width: fit-content;
  max-width: 100%;
  padding: 2px;
  overflow-x: auto;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--evo-radius-md);
  background: var(--dsw-alias-bg-layer-2);
}
.evo-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: .5px solid transparent;
  border-radius: var(--evo-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
.evo-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.evo-tab[aria-selected="true"] {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.evo-tab:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.evo-tab-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

/* 概览统计 */
.evo-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-top: .5px solid var(--dsw-alias-border-l2);
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.evo-stat { min-width: 0; padding: 12px 16px; border-left: .5px solid var(--dsw-alias-border-l2); cursor: pointer; }
.evo-stat:first-child { padding-left: 0; border-left: 0; }
.evo-stat:hover { background: var(--dsw-alias-interactive-bg-hover); }
.evo-stat-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-stat-val { margin-top: 2px; font-size: 20px; font-weight: 500; line-height: 28px; font-variant-numeric: tabular-nums; }
.evo-stat-sub { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 分节 */
.evo-sec { display: flex; flex-direction: column; }
.evo-sec-head { display: flex; align-items: center; gap: 12px; padding-bottom: 2px; }
.evo-sec-title { margin: 0; font-size: 14px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); }
.evo-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.evo-sec-head .evo-link-btn { margin-left: auto; }
.evo-sec-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.evo-more {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: auto; padding: 0; border: 0; border-radius: 4px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.evo-more:hover { color: var(--dsw-alias-label-primary); }

/* 列表行 */
.evo-list { display: flex; flex-direction: column; border-top: .5px solid var(--dsw-alias-border-l2); }
.evo-row-card { border-bottom: .5px solid var(--dsw-alias-border-l2); }
.evo-list > .evo-row-card:last-child { border-bottom: 0; }
.evo-row-line { display: flex; align-items: center; gap: 12px; padding: 16px 0; flex-wrap: wrap; min-width: 0; }
.evo-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.evo-row-title-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.evo-row-name {
  padding: 0; border: 0; border-radius: 4px; background: none; cursor: pointer;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; font-weight: 500; line-height: 20px;
  overflow: hidden; text-overflow: ellipsis;
}
.evo-row-name:hover { text-decoration: underline; text-underline-offset: 3px; }
.evo-row-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 56ch; }
.evo-row-end { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; }
.evo-row-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.evo-drawer { padding: 12px 0 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
.evo-drawer .evo-code-box { margin-top: 0; }

/* 徽章与文本 */
.evo-badge {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px;
  border: .5px solid var(--dsw-alias-label-secondary); border-radius: 999px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: nowrap;
}
.evo-badge-info { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.evo-badge-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.evo-kicker { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-mono { font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; }
.evo-muted { color: var(--dsw-alias-label-secondary); }
.evo-ink { color: var(--dsw-alias-label-primary); font-weight: 500; }
.evo-accent { color: var(--dsw-alias-state-business-primary); }
.evo-sep { color: var(--dsw-alias-label-tertiary); }
.evo-pitfall-item { overflow-wrap: anywhere; }
.evo-ok-label { color: var(--dsw-alias-label-primary); font-weight: 500; }

/* 按钮 */
.evo-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 12px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--evo-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.evo-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.evo-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.evo-btn:disabled { opacity: .45; cursor: not-allowed; }
.evo-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.evo-btn.primary { border-color: transparent; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); }
.evo-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-label-primary); opacity: .88; }
.evo-btn.ghost { background: transparent; color: var(--dsw-alias-label-primary); }
.evo-btn.danger { color: var(--dsw-alias-state-error-primary); }
.evo-btn.danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
.evo-ibtn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: var(--evo-radius-sm); background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.evo-ibtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.evo-ibtn.on { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-active); }
.evo-ibtn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.evo-link-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 0; border: 0; border-radius: 4px; background: none;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.evo-link-btn:hover { color: var(--dsw-alias-label-primary); }
.evo-link-btn:disabled { opacity: .45; cursor: not-allowed; }
.evo-link-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 2px; }

/* 草稿卡 */
.evo-draft-list { display: flex; flex-direction: column; border-top: .5px solid var(--dsw-alias-border-l2); }
.evo-draft { padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.evo-draft-list > .evo-draft:last-child { border-bottom: 0; }
.evo-draft-compact { padding: 12px 0; }
.evo-compact-row { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: nowrap; }
.evo-compact-name { flex: none; max-width: 26ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 20px; }
.evo-compact-sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-compact-actions { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; }
.evo-draft-kicker { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; color: var(--dsw-alias-label-secondary); }
.evo-draft-kicker .evo-link-btn { margin-left: auto; }
.evo-draft-main { padding: 0; }
.evo-draft-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; color: var(--dsw-alias-label-primary); }
.evo-draft-summary { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.evo-trigger-line { display: flex; align-items: baseline; gap: 8px; margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-trigger-line .evo-kicker { flex: none; }

/* 步骤、护栏、后果 */
.evo-steps-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px;
  margin-top: 8px; border-top: .5px solid var(--dsw-alias-border-l2);
}
.evo-step-cell {
  display: flex; flex-direction: column; gap: 2px;
  padding: 12px 0; border: 0; border-bottom: .5px solid var(--dsw-alias-border-l2);
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.evo-step-cell:hover, .evo-step-cell.on { background: var(--dsw-alias-interactive-bg-hover); }
.evo-step-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.evo-step-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.evo-step-add { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); opacity: 0; transition: opacity .12s ease; }
.evo-step-cell:hover .evo-step-add, .evo-step-cell.on .evo-step-add { opacity: 1; }
.evo-step-body { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.evo-pitfalls {
  display: flex; align-items: baseline; gap: 12px; padding: 12px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px;
}
.evo-pitfalls-list { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--dsw-alias-label-secondary); }
.evo-outcomes {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px;
  padding: 12px 0; border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.evo-outcome-cell { min-width: 0; }
.evo-outcome-cell p { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-ai-note {
  display: flex; align-items: baseline; gap: 12px; padding: 12px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.evo-ai-note .evo-kicker { flex: none; color: var(--dsw-alias-label-primary); }

/* 批示与操作 */
.evo-draft-foot { display: flex; flex-direction: column; gap: 8px; padding: 12px 0 0; }
.evo-pills-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.evo-pill {
  height: 28px; padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--evo-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, color .12s ease;
}
.evo-pill:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.evo-pill[aria-pressed="true"] {
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}
.evo-pill:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.evo-action-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.evo-input {
  height: 32px; padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--evo-radius-sm);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px;
}
.evo-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.evo-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: inset 0 0 0 .5px var(--dsw-alias-brand-primary);
}
.evo-directive-input { flex: 1; min-width: 240px; }
.evo-input-num { width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
.evo-input-wide { width: 240px; max-width: 100%; }
.evo-inline-fields { display: grid; grid-template-columns: repeat(2, 96px); gap: 8px; }

/* 搜索与工具栏 */
.evo-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.evo-search { position: relative; flex: 0 1 280px; }
.evo-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--dsw-alias-label-tertiary); }
.evo-search input {
  width: 100%; height: 32px; padding: 0 10px 0 32px;
  border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--evo-radius-sm);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px;
}
.evo-search input::placeholder { color: var(--dsw-alias-label-tertiary); }
.evo-search input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 .5px var(--dsw-alias-brand-primary); }

/* 代码与表格 */
.evo-code-box { margin-top: 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--evo-radius-md); background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.evo-code-fm { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 12px; border-bottom: .5px solid var(--dsw-alias-border-l2); font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-code-fm-item strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
.evo-code-pre { margin: 0; max-height: 320px; overflow: auto; padding: 8px 0; font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.evo-code-line { display: flex; padding: 0 12px; }
.evo-code-num { width: 24px; margin-right: 12px; flex: none; color: var(--dsw-alias-label-tertiary); text-align: right; user-select: none; }
.evo-code-txt { white-space: pre-wrap; word-break: break-word; }
.evo-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 18px; }
.evo-table th, .evo-table td { padding: 8px; border-bottom: .5px solid var(--dsw-alias-border-l2); text-align: left; vertical-align: top; }
.evo-table th { color: var(--dsw-alias-label-tertiary); font-weight: 400; white-space: nowrap; }

/* 设置分组（原生设置行） */
.evo-settings-box { margin: 0; }
.evo-settings-grid { display: flex; flex-direction: column; border-top: .5px solid var(--dsw-alias-border-l2); }
.evo-field { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.evo-field:last-child { border-bottom: 0; }
.evo-field-main { min-width: 0; }
.evo-field-label { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.evo-field-hint { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-field-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex: none; flex-wrap: wrap; }
.evo-settings-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
.evo-settings-foot .evo-kicker { overflow-wrap: anywhere; }

/* 开关（对齐宿主 36×20） */
.evo-switch {
  position: relative; flex: none; width: 36px; height: 20px; padding: 2px;
  border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  cursor: pointer; -webkit-appearance: none; appearance: none;
  transition: background-color .12s ease;
}
.evo-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.evo-switch:disabled { opacity: .45; cursor: not-allowed; }
.evo-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.evo-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform .12s ease;
}
.evo-switch[aria-checked="true"] .evo-thumb { transform: translateX(16px); }

/* 整理方案与空状态 */
.evo-tidy-box { display: flex; flex-direction: column; gap: 12px; padding: 12px 0; border-top: .5px solid var(--dsw-alias-border-l2); }
.evo-tidy-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.evo-tidy-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-tidy-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; }
.evo-tidy-cell { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-top: .5px solid var(--dsw-alias-border-l2); min-width: 0; }
.evo-tidy-cell-wide { grid-column: 1 / -1; }
.evo-tidy-item { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.evo-tidy-group { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: .5px solid var(--dsw-alias-border-l2); }
.evo-tidy-group:first-of-type { border-top: 0; }
.evo-tidy-group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.evo-tidy-group-name { font-size: 13px; font-weight: 500; line-height: 20px; }
.evo-tidy-members { display: flex; flex-wrap: wrap; gap: 6px; }
.evo-plan-box { display: flex; flex-direction: column; gap: 4px; padding: 12px 0; border-top: .5px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.evo-plan-box .evo-mono { overflow-wrap: anywhere; }
.evo-empty { padding: 16px 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.evo-empty p { margin: 4px 0 0; }
.evo-empty .evo-mono { display: inline-block; margin-bottom: 4px; color: var(--dsw-alias-label-tertiary); }
.evo-loading { padding: 64px 24px; text-align: center; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }

/* 浮层提示（不遮挡、无自造弹窗） */
.evo-toast {
  position: fixed; right: 24px; bottom: 24px; z-index: 9999;
  display: inline-flex; align-items: center; gap: 8px; max-width: min(420px, calc(100vw - 48px));
  padding: 10px 12px;
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--evo-radius-md);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 20px;
  box-shadow: var(--dsw-elevation-prominent);
}
.evo-toast .evo-kicker { color: var(--dsw-alias-label-secondary); }
.evo-toast.err { border-color: var(--dsw-alias-state-error-primary); }
.evo-toast.err .evo-kicker { color: var(--dsw-alias-state-error-primary); }

@media (max-width: 780px) {
  .evo-page { padding: 0 16px; }
  .evo-page-inner { padding: 20px 0 48px; }
  .evo-page-settings { padding: 0; }
  .evo-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .evo-stat { padding-left: 0; border-left: 0; }
  .evo-stat:nth-child(n + 3) { border-top: .5px solid var(--dsw-alias-border-l2); }
  .evo-step-cell { padding-left: 0; padding-right: 0; }
  .evo-steps-grid, .evo-outcomes, .evo-tidy-grid { grid-template-columns: 1fr; }
  .evo-field { flex-direction: column; align-items: stretch; gap: 8px; }
  .evo-field-control { justify-content: flex-start; }
  .evo-compact-row { flex-wrap: wrap; }
  .evo-compact-name, .evo-compact-sum { max-width: none; flex: 1 1 100%; white-space: normal; }
  .evo-compact-actions { margin-left: 0; }
  .evo-page-head { flex-direction: column; align-items: stretch; }
  .evo-head-actions { justify-content: flex-start; }
}
`;

    function renderPage(props) {
      return h(React.Fragment, null, h('style', null, CSS), h(EvolutionPanel, { ...props, variant: 'page' }));
    }

    function renderSettingsSection(props) {
      return h(React.Fragment, null, h('style', null, CSS), h(EvolutionPanel, { ...props, variant: 'settings' }));
    }

    function SidebarPanelIcon(props) {
      const sz = typeof props?.size === 'number' ? props.size : 18;
      return h(
        'svg',
        {
          width: sz,
          height: sz,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M12 3a9 9 0 1 0 9 9' }),
        h('path', { d: 'M12 7v5l3 3' }),
        h('path', { d: 'M17 3l3 3-3 3' }),
      );
    }

    function SettingsSectionIcon(props) {
      return h(SidebarPanelIcon, { size: typeof props?.size === 'number' ? props.size : 16 });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-evolution' }, renderPage),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-evolution',
              order: 15,
              label: () => '自进化',
            },
            SidebarPanelIcon,
          ),
        );
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-evolution',
              order: 30,
              label: () => '自进化',
            },
            renderSettingsSection,
          ),
        );
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'dsh-evolution' }, SettingsSectionIcon),
        );
      },
    };
  },
});
/* hmr-rev: 1794203235 */

/* hmr-rev: 1794220549 */
