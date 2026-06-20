import type { RecordStatus } from "../api/types";
import { STATUS_LABEL } from "../lib/format";

export default function StatusDot({
  status,
  withLabel = true,
}: {
  status: RecordStatus;
  withLabel?: boolean;
}) {
  return (
    <span title={STATUS_LABEL[status]}>
      <span className={`dot dot-${status}`} />
      {withLabel && <span>{STATUS_LABEL[status]}</span>}
    </span>
  );
}
