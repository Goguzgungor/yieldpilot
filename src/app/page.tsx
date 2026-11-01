import PlateApp from "./_components/PlateApp";

// Plate I is fully client-rendered (canvas + polling + Freighter). Render the
// client component from this server page.
export default function Home() {
  return <PlateApp />;
}
