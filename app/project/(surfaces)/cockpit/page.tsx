import { Cockpit } from "./_components/cockpit";

/**
 * The PM cockpit: what needs a decision, how each epic is doing, and what the
 * agents are working on, in plain language (devolps PC-01..PC-11).
 *
 * Client-rendered and polled, like the agents surface: decisions arrive while
 * the page is open, and a page that is right only at load time is wrong for
 * most of the time somebody looks at it.
 */
const CockpitPage = ({ searchParams }: { searchParams: { root?: string } }) => (
  <Cockpit root={searchParams.root} />
);

export default CockpitPage;
