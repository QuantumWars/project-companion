import { MissionControl } from "./_components/mission-control";

/**
 * What the agents are doing, right now.
 *
 * Client-rendered rather than server-rendered, unlike the component workspace:
 * a run changes every few seconds while one is open, and a page that is correct
 * only at request time is a page that is wrong for most of the time you look
 * at it.
 */
const AgentsPage = ({ searchParams }: { searchParams: { root?: string } }) => (
  <MissionControl root={searchParams.root} />
);

export default AgentsPage;
