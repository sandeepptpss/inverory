import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  return redirect(`/app/inventory-tags${url.search}`);
};

export default function Index() {
  return null;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
