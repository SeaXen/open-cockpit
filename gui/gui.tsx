import { Command, Panel, type PanelTab, Plugin } from "@opencode/plugin/gui";
import { createSignal, onMount } from "solid-js";

// Same shape as the server part's RPC definition.
const CockpitRpc = {
  id: "open-cockpit",
  methods: {
    snapshot: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
};

const tab: PanelTab = {
  id: "main",
  get title() {
    return "Open Cockpit";
  },
  closable: "compact",
  fallback: true,
};

function View(props: { ctx: any; session: any }) {
  const [text, setText] = createSignal("Reading local usage…");
  onMount(async () => {
    try {
      const rpc = props.ctx.client.rpc(CockpitRpc);
      const result = await rpc.snapshot({});
      setText(result.text);
    } catch (error) {
      setText(`Unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return (
    <div
      style={{
        padding: "10px",
        "font-family": "var(--font-mono, monospace)",
        "font-size": "12px",
        "line-height": "1.5",
        "white-space": "pre-wrap",
        overflow: "auto",
        height: "100%",
        color: "var(--foreground-1000, inherit)",
      }}
    >
      {text()}
    </div>
  );
}

export default Plugin.define({
  i18n: { en: { "command.open": "Open Cockpit" } },
  setup(ctx) {
    ctx.add(Panel, {
      id: "main",
      region: "side",
      width: "narrow",
      list: (input) => (input.open.includes("main") ? [tab] : []),
      render: (props) => <View ctx={ctx} session={props.session} />,
    });
    ctx.add(Command, {
      id: "open",
      title: ctx.t("command.open"),
      run: () => {
        const session = ctx.sessions.current();
        if (session) ctx.layout.open("open-cockpit:main", session);
      },
    });
  },
});
