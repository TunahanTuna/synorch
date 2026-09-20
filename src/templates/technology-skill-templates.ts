export const TECHNOLOGY_SKILL_TEMPLATES: Readonly<Record<string, string>> = {
  "typescript-patterns": `---
name: typescript-patterns
description: Use when implementing or reviewing code in a module verified to use TypeScript.
---

# TypeScript Patterns

Respect the module's configured TypeScript version and strictness. Model domain states explicitly, narrow unknown values at external boundaries, and prefer inference over duplicated annotations. Do not use \`any\`, non-null assertions, or broad casts to bypass a type error without evidence that the runtime invariant is enforced. Verify with the module's typecheck command.
`,
  "react-patterns": `---
name: react-patterns
description: Use when implementing or reviewing a module verified to use React.
---

# React Patterns

Follow the module's existing component, routing, state, and styling conventions. Keep render logic pure, colocate state with its owner, clean up effects, and preserve client/server boundaries when the framework has them. Prefer accessible semantic controls and test observable user behavior instead of implementation details.
`,
  "java-patterns": `---
name: java-patterns
description: Use when implementing or reviewing code in a module verified to use Java.
---

# Java Patterns

Honor the configured Java release and established package boundaries. Make invalid states difficult to represent, keep nullability and exception behavior explicit, and avoid hidden shared mutability. Prefer small cohesive types over speculative abstractions. Compile and test through the module's verified build tool.
`,
  "spring-boot-patterns": `---
name: spring-boot-patterns
description: Use when working in a module with verified Spring Boot evidence.
---

# Spring Boot Patterns

Keep HTTP concerns at the controller boundary and business rules in application or domain services. Prefer constructor injection, validated request models, explicit error-to-response mapping, and configuration properties over scattered environment reads. Place transaction ownership at a service boundary and test behavior with the narrowest Spring test slice that proves it.
`,
  "jpa-patterns": `---
name: jpa-patterns
description: Use when persistence work targets a module with verified JPA or Hibernate evidence.
---

# JPA Patterns

Design entity relationships around aggregate ownership and actual query paths. Define transaction and fetch boundaries deliberately; inspect generated access patterns for N+1 queries and unintended writes. Keep API serialization separate from managed entities, and pair schema-affecting changes with the project's migration mechanism and repository-level tests.
`,
  "maven-build": `---
name: maven-build
description: Use for build or dependency work in a module with verified Maven evidence.
---

# Maven Build

Use the project wrapper when present and preserve the existing parent, BOM, profile, and plugin-management strategy. Add dependencies at the narrowest correct scope and avoid overriding managed versions without a demonstrated need. Verify focused tests first, then the relevant Maven lifecycle phase used by CI.
`,
  "gradle-build": `---
name: gradle-build
description: Use for build or dependency work in a module with verified Gradle evidence.
---

# Gradle Build

Use the project wrapper and follow its Groovy or Kotlin DSL conventions. Respect existing version catalogs, convention plugins, configurations, and module boundaries. Avoid eager configuration and unscoped dependency additions. Run focused tasks first, then the relevant Gradle checks used by CI.
`,
};

export function getTechnologySkillTemplate(skillId: string): string {
  const template = TECHNOLOGY_SKILL_TEMPLATES[skillId];
  if (template === undefined) {
    throw new Error(`Missing technology skill template for ${skillId}`);
  }
  return template.endsWith("\n") ? template : `${template}\n`;
}
