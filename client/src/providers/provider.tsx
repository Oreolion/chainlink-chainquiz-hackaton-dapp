"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { config } from "../lib/wagmi.config";

const queryClient = new QueryClient();

export function Providers({ children, cookie }: { children: React.ReactNode; cookie?: string | null }) {
  // Safely parse cookie to avoid SyntaxError
  let initialState;
  try {
    if (cookie) {
      // Assuming cookie contains a JSON-serialized Wagmi state
      // Parse only the relevant part (e.g., wagmi-specific cookie)
      const wagmiCookie = cookie
        .split("; ")
        .find((c) => c.startsWith("wagmi.store="))
        ?.split("=")[1];
      initialState = wagmiCookie ? JSON.parse(decodeURIComponent(wagmiCookie)) : undefined;
    }
  } catch (err) {
    console.error("Failed to parse cookie for WagmiProvider:", err);
    initialState = undefined;
  }

  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}