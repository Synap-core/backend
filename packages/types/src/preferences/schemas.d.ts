/**
 * User Preferences Schemas - UI-Specific Validation Only
 *
 * Database schemas come from @synap/database/schema
 * This file contains ONLY frontend/UI-specific Zod schemas
 */
import { type z } from "zod";
export declare const CustomThemeSchema: z.ZodOptional<
  z.ZodObject<
    {
      colors: z.ZodOptional<
        z.ZodObject<
          {
            primary: z.ZodOptional<z.ZodString>;
            accent: z.ZodOptional<z.ZodString>;
            background: z.ZodOptional<z.ZodString>;
            border: z.ZodOptional<z.ZodString>;
            text: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >
      >;
      spacing: z.ZodOptional<
        z.ZodObject<
          {
            small: z.ZodOptional<z.ZodString>;
            medium: z.ZodOptional<z.ZodString>;
            large: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >
      >;
      radii: z.ZodOptional<
        z.ZodObject<
          {
            small: z.ZodOptional<z.ZodString>;
            medium: z.ZodOptional<z.ZodString>;
            large: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >
      >;
      animations: z.ZodOptional<
        z.ZodObject<
          {
            enabled: z.ZodOptional<z.ZodBoolean>;
            speed: z.ZodOptional<
              z.ZodEnum<{
                slow: "slow";
                normal: "normal";
                fast: "fast";
              }>
            >;
          },
          z.core.$strip
        >
      >;
    },
    z.core.$strip
  >
>;
export declare const UIPreferencesSchema: z.ZodOptional<
  z.ZodObject<
    {
      sidebarCollapsed: z.ZodOptional<z.ZodBoolean>;
      panelPositions: z.ZodOptional<
        z.ZodRecord<
          z.ZodString,
          z.ZodObject<
            {
              x: z.ZodNumber;
              y: z.ZodNumber;
            },
            z.core.$strip
          >
        >
      >;
      lastActiveView: z.ZodOptional<z.ZodString>;
      compactMode: z.ZodOptional<z.ZodBoolean>;
      fontSize: z.ZodOptional<z.ZodString>;
      animations: z.ZodOptional<z.ZodBoolean>;
      defaultView: z.ZodOptional<
        z.ZodEnum<{
          list: "list";
          grid: "grid";
          timeline: "timeline";
        }>
      >;
      entityOpenMode: z.ZodOptional<
        z.ZodEnum<{
          floating: "floating";
          side: "side";
          modal: "modal";
        }>
      >;
    },
    z.core.$strip
  >
>;
export declare const GraphPreferencesSchema: z.ZodOptional<
  z.ZodObject<
    {
      forceSettings: z.ZodOptional<
        z.ZodObject<
          {
            linkDistance: z.ZodOptional<z.ZodNumber>;
            chargeStrength: z.ZodOptional<z.ZodNumber>;
            alphaDecay: z.ZodOptional<z.ZodNumber>;
            velocityDecay: z.ZodOptional<z.ZodNumber>;
          },
          z.core.$strip
        >
      >;
      defaultFilters: z.ZodOptional<
        z.ZodObject<
          {
            entityTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            relationTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
          },
          z.core.$strip
        >
      >;
      zoom: z.ZodOptional<z.ZodNumber>;
      pan: z.ZodOptional<
        z.ZodObject<
          {
            x: z.ZodNumber;
            y: z.ZodNumber;
          },
          z.core.$strip
        >
      >;
      showMinimap: z.ZodOptional<z.ZodBoolean>;
    },
    z.core.$strip
  >
>;
export declare const UpdatePreferencesInputSchema: z.ZodObject<
  {
    theme: z.ZodOptional<
      z.ZodEnum<{
        system: "system";
        light: "light";
        dark: "dark";
      }>
    >;
    customTheme: z.ZodOptional<
      z.ZodObject<
        {
          colors: z.ZodOptional<
            z.ZodObject<
              {
                primary: z.ZodOptional<z.ZodString>;
                accent: z.ZodOptional<z.ZodString>;
                background: z.ZodOptional<z.ZodString>;
                border: z.ZodOptional<z.ZodString>;
                text: z.ZodOptional<z.ZodString>;
              },
              z.core.$strip
            >
          >;
          spacing: z.ZodOptional<
            z.ZodObject<
              {
                small: z.ZodOptional<z.ZodString>;
                medium: z.ZodOptional<z.ZodString>;
                large: z.ZodOptional<z.ZodString>;
              },
              z.core.$strip
            >
          >;
          radii: z.ZodOptional<
            z.ZodObject<
              {
                small: z.ZodOptional<z.ZodString>;
                medium: z.ZodOptional<z.ZodString>;
                large: z.ZodOptional<z.ZodString>;
              },
              z.core.$strip
            >
          >;
          animations: z.ZodOptional<
            z.ZodObject<
              {
                enabled: z.ZodOptional<z.ZodBoolean>;
                speed: z.ZodOptional<
                  z.ZodEnum<{
                    slow: "slow";
                    normal: "normal";
                    fast: "fast";
                  }>
                >;
              },
              z.core.$strip
            >
          >;
        },
        z.core.$strip
      >
    >;
    defaultTemplates: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    customEntityTypes: z.ZodOptional<z.ZodArray<z.ZodAny>>;
    entityMetadataSchemas: z.ZodOptional<
      z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodAny>>
    >;
    uiPreferences: z.ZodOptional<
      z.ZodObject<
        {
          sidebarCollapsed: z.ZodOptional<z.ZodBoolean>;
          panelPositions: z.ZodOptional<
            z.ZodRecord<
              z.ZodString,
              z.ZodObject<
                {
                  x: z.ZodNumber;
                  y: z.ZodNumber;
                },
                z.core.$strip
              >
            >
          >;
          lastActiveView: z.ZodOptional<z.ZodString>;
          compactMode: z.ZodOptional<z.ZodBoolean>;
          fontSize: z.ZodOptional<z.ZodString>;
          animations: z.ZodOptional<z.ZodBoolean>;
          defaultView: z.ZodOptional<
            z.ZodEnum<{
              list: "list";
              grid: "grid";
              timeline: "timeline";
            }>
          >;
          entityOpenMode: z.ZodOptional<
            z.ZodEnum<{
              floating: "floating";
              side: "side";
              modal: "modal";
            }>
          >;
        },
        z.core.$strip
      >
    >;
    graphPreferences: z.ZodOptional<
      z.ZodObject<
        {
          forceSettings: z.ZodOptional<
            z.ZodObject<
              {
                linkDistance: z.ZodOptional<z.ZodNumber>;
                chargeStrength: z.ZodOptional<z.ZodNumber>;
                alphaDecay: z.ZodOptional<z.ZodNumber>;
                velocityDecay: z.ZodOptional<z.ZodNumber>;
              },
              z.core.$strip
            >
          >;
          defaultFilters: z.ZodOptional<
            z.ZodObject<
              {
                entityTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                relationTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
              },
              z.core.$strip
            >
          >;
          zoom: z.ZodOptional<z.ZodNumber>;
          pan: z.ZodOptional<
            z.ZodObject<
              {
                x: z.ZodNumber;
                y: z.ZodNumber;
              },
              z.core.$strip
            >
          >;
          showMinimap: z.ZodOptional<z.ZodBoolean>;
        },
        z.core.$strip
      >
    >;
    onboardingCompleted: z.ZodOptional<z.ZodBoolean>;
    onboardingStep: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
//# sourceMappingURL=schemas.d.ts.map
