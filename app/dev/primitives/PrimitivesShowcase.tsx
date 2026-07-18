"use client";

import { useState } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { Badge } from "@/components/shared/Badge";
import { Button } from "@/components/shared/Button";
import { Card } from "@/components/shared/Card";
import { Checkbox } from "@/components/shared/Checkbox";
import { CopyButton } from "@/components/shared/CopyButton";
import { IconButton } from "@/components/shared/IconButton";
import { Kbd } from "@/components/shared/Kbd";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { Markdown } from "@/components/shared/Markdown";
import { Modal } from "@/components/shared/Modal";
import { MonoId } from "@/components/shared/MonoId";
import { PriorityIcon, type Priority } from "@/components/shared/PriorityIcon";
import { ProgressBar } from "@/components/shared/ProgressBar";
import { StatusGlyph, type TaskStatus } from "@/components/shared/StatusGlyph";
import { TabSwitcher } from "@/components/shared/TabSwitcher";
import { TeamChip } from "@/components/shared/TeamChip";
import { ViewTabs } from "@/components/shared/ViewTabs";
import {
  IconAgent,
  IconArrowRight,
  IconBranch,
  IconBundle,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconCommand,
  IconDoc,
  IconFilter,
  IconFlag,
  IconGraph,
  IconInbox,
  IconLink,
  IconList,
  IconTasks,
  IconLock,
  IconMoon,
  IconMore,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSort,
  IconSpark,
  IconSun,
  IconTag,
  IconTrash,
  IconUser,
  IconUsers,
  IconX,
} from "@/components/shared/icons";

const STATUSES: TaskStatus[] = [
  "draft",
  "planned",
  "ready",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];
const PRIORITIES: Priority[] = [null, "backlog", "normal", "core", "urgent"];

interface SectionProps {
  title: string;
  caption?: string;
  children: React.ReactNode;
}

/**
 * Visual section in the primitives gallery — title + caption + slot.
 * @param props - Section configuration.
 * @returns A bordered section block.
 */
function Section({ title, caption, children }: SectionProps) {
  return (
    <section
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: 20,
        background: "var(--color-surface)",
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {title}
        </h2>
        {caption ? (
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              color: "var(--color-text-muted)",
            }}
          >
            {caption}
          </p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

interface SwatchProps {
  name: string;
  value: string;
  isGradient?: boolean;
}

function Swatch({ name, value, isGradient = false }: SwatchProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 8,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-raised)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: isGradient ? `var(${value})` : `var(${value})`,
          border: "1px solid var(--color-border-strong)",
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--color-text-secondary)",
        }}
      >
        {name}
      </span>
    </div>
  );
}

const ICONS_LIST: Array<{ name: string; node: React.ReactNode }> = [
  { name: "ChevronDown", node: <IconChevronDown size={16} /> },
  { name: "ChevronRight", node: <IconChevronRight size={16} /> },
  { name: "ChevronUp", node: <IconChevronUp size={16} /> },
  { name: "ChevronLeft", node: <IconChevronLeft size={16} /> },
  { name: "Search", node: <IconSearch size={16} /> },
  { name: "Inbox", node: <IconInbox size={16} /> },
  { name: "Agent", node: <IconAgent size={16} /> },
  { name: "User", node: <IconUser size={16} /> },
  { name: "Users", node: <IconUsers size={16} /> },
  { name: "Plus", node: <IconPlus size={16} /> },
  { name: "Filter", node: <IconFilter size={16} /> },
  { name: "Sort", node: <IconSort size={16} /> },
  { name: "List", node: <IconList size={16} /> },
  { name: "Tasks", node: <IconTasks size={16} /> },
  { name: "Graph", node: <IconGraph size={16} /> },
  { name: "Link", node: <IconLink size={16} /> },
  { name: "Spark", node: <IconSpark size={16} /> },
  { name: "Settings", node: <IconSettings size={16} /> },
  { name: "Moon", node: <IconMoon size={16} /> },
  { name: "Sun", node: <IconSun size={16} /> },
  { name: "Check", node: <IconCheck size={16} /> },
  { name: "X", node: <IconX size={16} /> },
  { name: "More", node: <IconMore size={16} /> },
  { name: "ArrowRight", node: <IconArrowRight size={16} /> },
  { name: "Command", node: <IconCommand size={16} /> },
  { name: "Doc", node: <IconDoc size={16} /> },
  { name: "Branch", node: <IconBranch size={16} /> },
  { name: "Bundle", node: <IconBundle size={16} /> },
  { name: "Lock", node: <IconLock size={16} /> },
  { name: "Flag", node: <IconFlag size={16} /> },
  { name: "Tag", node: <IconTag size={16} /> },
  { name: "Clock", node: <IconClock size={16} /> },
  { name: "Trash", node: <IconTrash size={16} /> },
];

/**
 * Long-scroll showcase rendering every primitive in every state. Used to eyeball
 * the design system before screens consume it.
 *
 * @returns A composed page of sections — tokens, icons, buttons, glyphs, etc.
 */
export function PrimitivesShowcase() {
  const [tab, setTab] = useState("structure");
  const [view, setView] = useState("list");
  const [check1, setCheck1] = useState(false);
  const [check2, setCheck2] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 24,
        background: "var(--color-base)",
        position: "relative",
        zIndex: 2,
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <header style={{ marginBottom: 8 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              lineHeight: 1.15,
            }}
          >
            Primitives
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              color: "var(--color-text-muted)",
              fontSize: 13.5,
            }}
          >
            Phase 0 design system: every shared primitive in every state. Toggle
            the theme via the existing app theme to verify light/dark parity.
          </p>
        </header>

        <Section
          title="Tokens · colour"
          caption="Surfaces, text, accents, status glyph fills."
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 8,
            }}
          >
            <Swatch name="--color-base" value="--color-base" />
            <Swatch name="--color-base-2" value="--color-base-2" />
            <Swatch name="--color-surface" value="--color-surface" />
            <Swatch
              name="--color-surface-raised"
              value="--color-surface-raised"
            />
            <Swatch
              name="--color-surface-hover"
              value="--color-surface-hover"
            />
            <Swatch name="--color-accent" value="--color-accent" />
            <Swatch name="--color-accent-2" value="--color-accent-2" />
            <Swatch name="--color-accent-light" value="--color-accent-light" />
            <Swatch
              name="--color-accent-grad"
              value="--color-accent-grad"
              isGradient
            />
            <Swatch name="--color-glyph-draft" value="--color-glyph-draft" />
            <Swatch
              name="--color-glyph-planned"
              value="--color-glyph-planned"
            />
            <Swatch name="--color-glyph-ready" value="--color-glyph-ready" />
            <Swatch
              name="--color-glyph-progress"
              value="--color-glyph-progress"
            />
            <Swatch name="--color-glyph-done" value="--color-glyph-done" />
            <Swatch
              name="--color-glyph-blocked"
              value="--color-glyph-blocked"
            />
            <Swatch
              name="--color-glyph-cancelled"
              value="--color-glyph-cancelled"
            />
          </div>
        </Section>

        <Section
          title="Type scale"
          caption="Inter for body, Geist Mono for IDs and section labels."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p
              style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                lineHeight: 1.15,
              }}
            >
              Page H1 · 26 / 600 / -0.01em
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: "-0.005em",
                lineHeight: 1.2,
              }}
            >
              Detail title · 22 / 600
            </p>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Section H2 · 16 / 600
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 13.5,
                fontWeight: 450,
                lineHeight: 1.55,
              }}
            >
              Body · 13.5 / 450 with leading 1.55. The agent-native project
              graph. Walk into every session knowing what to do next.
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-text-secondary)",
              }}
            >
              Label · 12 / 500 muted
            </p>
            <p
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--color-text-muted)",
              }}
            >
              Section label · 11 / 600 mono uppercase 0.08em
            </p>
            <p
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: "0.02em",
              }}
            >
              PYZ-104 · mono 11 / 500
            </p>
          </div>
        </Section>

        <Section
          title="Buttons"
          caption="Variants × sizes. Primary uses brand gradient on dark text."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {(["sm", "md", "lg"] as const).map((size) => (
              <div
                key={size}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: "var(--color-text-muted)",
                    minWidth: 24,
                  }}
                >
                  {size}
                </span>
                <Button variant="primary" size={size}>
                  Primary
                </Button>
                <Button variant="secondary" size={size}>
                  Secondary
                </Button>
                <Button variant="ghost" size={size}>
                  Ghost
                </Button>
                <Button variant="danger" size={size}>
                  Danger
                </Button>
                <Button variant="copy" size={size}>
                  copy
                </Button>
                <Button
                  variant="primary"
                  size={size}
                  icon={<IconPlus size={12} />}
                >
                  New task
                </Button>
                <Button
                  variant="secondary"
                  size={size}
                  icon={<IconSearch size={12} />}
                  kbd="⌘K"
                >
                  Jump
                </Button>
                <Button variant="secondary" size={size} disabled>
                  Disabled
                </Button>
                <Button variant="primary" size={size} isLoading>
                  Loading
                </Button>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Status glyphs + Badges"
          caption="Lifecycle status mapping."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                alignItems: "center",
              }}
            >
              {STATUSES.map((s) => (
                <div
                  key={s}
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <StatusGlyph status={s} size={18} />
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {s}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {STATUSES.map((s) => (
                <Badge key={s} status={s} />
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Badge status="depends_on" />
              <Badge status="blocks" />
              <Badge status="relates_to" />
              <Badge status="parent_of" />
            </div>
          </div>
        </Section>

        <Section
          title="Priority"
          caption="Four ascending bars. Maps schema backlog / normal / core / urgent / null."
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "center",
            }}
          >
            {PRIORITIES.map((p) => (
              <div
                key={String(p)}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <PriorityIcon priority={p} />
                <span
                  style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
                >
                  {p ?? "null"}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Avatar"
          caption="Initials, deterministic gradient. 18 / 22 / 28 / 56."
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "center",
            }}
          >
            {[18, 22, 28, 56].map((s) => (
              <Avatar key={s} name="Frkn Ak" size={s} />
            ))}
            <Avatar name="Claude" size={28} />
            <Avatar name="Codex" size={28} />
            <Avatar name="Frkn Ak" size={28} accent />
            <Avatar name="Frkn" size={28} ring />
            <Avatar name={null} size={28} />
          </div>
        </Section>

        <Section title="Kbd + MonoId">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              alignItems: "center",
            }}
          >
            <Kbd>⌘K</Kbd>
            <Kbd>N</Kbd>
            <Kbd>ESC</Kbd>
            <Kbd dim>?</Kbd>
            <span
              style={{
                width: 1,
                height: 18,
                background: "var(--color-border)",
              }}
            />
            <MonoId id="PYZ-104" />
            <MonoId id="PYZ-220" />
            <MonoId id="PYZ-301" dim />
            <MonoId id="PYZ-410" copyable={false} />
          </div>
        </Section>

        <Section
          title="ViewTabs"
          caption="Underline-style sub-page tabs with keyboard arrow nav."
        >
          <ViewTabs
            tabs={[
              { id: "list", label: "Tasks", icon: <IconTasks size={12} /> },
              { id: "graph", label: "Graph", icon: <IconGraph size={12} /> },
              {
                id: "agent",
                label: "Agent feed",
                icon: <IconAgent size={12} />,
                pulse: true,
              },
            ]}
            activeId={view}
            onChange={setView}
          />
        </Section>

        <Section
          title="TabSwitcher"
          caption="Pill segmented control with sliding indicator."
        >
          <TabSwitcher
            activeTab={tab}
            onTabChange={setTab}
            tabs={[
              { id: "structure", label: "Structure" },
              { id: "graph", label: "Graph" },
              { id: "feed", label: "Agent feed", glow: true },
            ]}
          />
        </Section>

        <Section title="Card" caption="Two examples: plain and hoverable.">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
            }}
          >
            <Card padded>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                Plain card
              </h3>
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 12.5,
                  color: "var(--color-text-muted)",
                }}
              >
                Surface + 1px border + card shadow.
              </p>
            </Card>
            <Card hover padded onClick={() => undefined}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                Hoverable card
              </h3>
              <p
                style={{
                  margin: "6px 0 0",
                  fontSize: 12.5,
                  color: "var(--color-text-muted)",
                }}
              >
                Glow-on-hover with stronger border and lift shadow.
              </p>
            </Card>
          </div>
        </Section>

        <Section title="Checkbox">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Checkbox
              checked={check1}
              onChange={setCheck1}
              label="Pending acceptance criterion"
            />
            <Checkbox
              checked={check2}
              onChange={setCheck2}
              label="Completed acceptance criterion"
            />
          </div>
        </Section>

        <Section title="ProgressBar">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              maxWidth: 480,
            }}
          >
            <ProgressBar value={0} status="in-progress" />
            <ProgressBar value={32} status="in-progress" />
            <ProgressBar value={68} status="in-progress" />
            <ProgressBar value={100} status="done" />
          </div>
        </Section>

        <Section title="LoadingSpinner">
          <LoadingSpinner />
        </Section>

        <Section title="IconButton">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <IconButton label="Search">
              <IconSearch size={14} />
            </IconButton>
            <IconButton label="More">
              <IconMore size={14} />
            </IconButton>
            <IconButton label="Theme" variant="secondary">
              <IconMoon size={14} />
            </IconButton>
            <IconButton label="Add" variant="secondary" size={32}>
              <IconPlus size={16} />
            </IconButton>
          </div>
        </Section>

        <Section title="TeamChip">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            <TeamChip team={{ id: "team-1", name: "piyaz" }} />
            <TeamChip team={{ id: "team-2", name: "partners" }} size="sm" />
            <TeamChip
              team={{ id: "team-3", name: "platform" }}
              showDot={false}
            />
          </div>
        </Section>

        <Section title="CopyButton">
          <CopyButton text="PYZ-104" />
        </Section>

        <Section title="Modal">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>
            Open modal
          </Button>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title="Sample modal"
          >
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--color-text-secondary)",
              }}
            >
              Backdrop + escape + click-outside + close button. Radius is 10px
              per spec.
            </p>
          </Modal>
        </Section>

        <Section title="Markdown">
          <Markdown>{`### Spec\n\n- bullet\n- another bullet with \`code\`\n\n> Block quote with **bold** and *italic*.`}</Markdown>
        </Section>

        <Section
          title="Icons"
          caption="Centralised SVG icon set, sized via currentColor."
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
              gap: 8,
            }}
          >
            {ICONS_LIST.map(({ name, node }) => (
              <div
                key={name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: "var(--color-surface-raised)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {node}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {name}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
