export const routes = [
  { path: "/", label: "Home" },
  { path: "/projects", label: "Projects" },
  { path: "/studio/image-graphic", label: "Image & Graphic Studio" },
  { path: "/pdf/create", label: "Create PDF" },
  { path: "/pdf/manage", label: "Edit & Manage PDF" },
  { path: "/production", label: "Print & Production" },
] as const;

export type AppRoute = (typeof routes)[number];

export const majorOutcomes = routes.slice(2) as readonly AppRoute[];

export function routeFor(pathname: string): AppRoute {
  return routes.find((route) => route.path === pathname) ?? routes[0];
}
