import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { colors } from "../../theme/tokens";

// Event Node - Blue Circle
export const EventNode = memo(({ data }: NodeProps) => {
  return (
    <div
      style={{
        padding: "12px 20px",
        borderRadius: "24px",
        background: colors.eventTypes.created,
        color: colors.text.inverse,
        border: `2px solid ${colors.eventTypes.created}`,
        fontSize: "12px",
        fontWeight: 600,
        minWidth: "120px",
        textAlign: "center",
        boxShadow: "0 4px 12px rgba(139, 92, 246, 0.3)",
      }}
    >
      <div>🎯 {data.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

EventNode.displayName = "EventNode";

// Worker Node - Purple Rounded Rectangle
export const WorkerNode = memo(({ data }: NodeProps) => {
  return (
    <div
      style={{
        padding: "14px 18px",
        borderRadius: "12px",
        background: colors.eventTypes.ai,
        color: colors.text.inverse,
        border: `2px solid ${colors.eventTypes.ai}`,
        fontSize: "12px",
        fontWeight: 600,
        minWidth: "140px",
        boxShadow: "0 4px 12px rgba(245, 158, 11, 0.3)",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div>⚙️ {data.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

WorkerNode.displayName = "WorkerNode";

// n8n Workflow Node - Green Hexagon with External Link
export const N8nNode = memo(({ data }: NodeProps) => {
  const handleClick = () => {
    if (data.workflowUrl) {
      window.open(data.workflowUrl, "_blank");
    }
  };

  return (
    <div
      onClick={handleClick}
      style={{
        padding: "14px 18px",
        borderRadius: "8px",
        background: colors.semantic.success,
        color: colors.text.inverse,
        border: `2px solid ${colors.semantic.success}`,
        fontSize: "12px",
        fontWeight: 600,
        minWidth: "140px",
        cursor: data.workflowUrl ? "pointer" : "default",
        boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)",
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span>🔗 n8n: {data.label}</span>
        {data.workflowUrl && <span style={{ fontSize: "10px" }}>↗</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

N8nNode.displayName = "N8nNode";

// Resource Node - Gray Cylinder/Barrel
export const ResourceNode = memo(({ data }: NodeProps) => {
  return (
    <div
      style={{
        padding: "14px 18px",
        borderRadius: "8px",
        background: "#6c757d",
        color: colors.text.inverse,
        border: "2px solid #5a6268",
        fontSize: "12px",
        fontWeight: 600,
        minWidth: "120px",
        textAlign: "center",
        boxShadow: "0 4px 12px rgba(108, 117, 125, 0.3)",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div>💾 {data.label}</div>
    </div>
  );
});

ResourceNode.displayName = "ResourceNode";

// LangFlow Node - Teal/Cyan Rounded
export const LangFlowNode = memo(({ data }: NodeProps) => {
  const handleClick = () => {
    if (data.flowUrl) {
      window.open(data.flowUrl, "_blank");
    }
  };

  return (
    <div
      onClick={handleClick}
      style={{
        padding: "14px 18px",
        borderRadius: "12px",
        background: "#06b6d4",
        color: colors.text.inverse,
        border: "2px solid #0891b2",
        fontSize: "12px",
        fontWeight: 600,
        minWidth: "140px",
        cursor: data.flowUrl ? "pointer" : "default",
        boxShadow: "0 4px 12px rgba(6, 182, 212, 0.3)",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span>🤖 LangFlow: {data.label}</span>
        {data.flowUrl && <span style={{ fontSize: "10px" }}>↗</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

LangFlowNode.displayName = "LangFlowNode";
