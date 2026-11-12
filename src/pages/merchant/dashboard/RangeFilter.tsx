import { useDashboardStore } from '../../../stores/dashboard'
import RangePills, { DAY_RANGE_OPTIONS } from '../../../components/ui/RangePills'

export default function RangeFilter() {
  const { range, setRange } = useDashboardStore()

  return (
    <div className="mb-4">
      <RangePills value={range} onChange={setRange} options={DAY_RANGE_OPTIONS} ariaLabel="经营数据时间范围" />
    </div>
  )
}
