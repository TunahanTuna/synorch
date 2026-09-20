---
name: java-backend
description: Modern Java backend engineering, current as of September 2026 (Java 25 LTS, Spring Boot 4 / Spring Framework 7) - the language as it is now (records, sealed types, pattern matching, virtual threads, structured concurrency), Spring Boot architecture that stays thin at the controller and rich in the domain, transaction and persistence boundaries that do not leak, configuration and profiles, Maven/Gradle wrapper discipline with the exact commands worth knowing, fast feedback loops (test slices, Testcontainers), observability with Micrometer, and a diagnosis playbook for when a service is slow or wrong. Carries an existing-codebase protocol - detect the installed Java and Spring versions, match the repo's paradigm, modernize only as an explicit opt-in. Use when writing, reviewing, upgrading or debugging Java or Spring Boot services, structuring a Java project, or asking how to work efficiently in a Java codebase. Türkçe tetikleyiciler - "java projesinde çalış", "spring boot servisi yaz", "java best practice", "maven komutu", "gradle build", "java sürümünü yükselt", "spring boot mimarisi", "java testleri hızlandır", "virtual thread", "java'da performans sorunu".
---

# Java Backend

You write Java the way Java is in 2026: records and sealed hierarchies instead of getter-soup beans, pattern matching instead of instanceof ladders, virtual threads instead of thread-pool tuning rituals, and Spring Boot used as a thin delivery shell around a domain that would still compile without it.

Always communicate with the user in their own language.

## Freshness protocol

Current as of **September 2026**: Java 25 (LTS, Sept 2025; 21 is the previous LTS and still very common), Spring Boot 4.0 / Spring Framework 7 (Nov 2025, Java 17+ baseline, JSpecify nullability, declarative HTTP clients), Maven 4, Gradle 9, JUnit 6, Testcontainers. Before locking a version or upgrade decision, verify against openjdk.org and spring.io/blog — if reality moved past this skill, reality wins and say so.

## Existing codebase protocol (read before touching an old project)

- **Detect reality first**: Java version from `pom.xml` / `build.gradle(.kts)` (`maven.compiler.release`, `java.toolchain`), Spring Boot from the parent or plugin version, then read three real classes to learn the repo's paradigm — field injection? `javax.*` or `jakarta.*`? layered or hexagonal? Lombok or records?
- **Consistency beats modernity inside a codebase.** A records-and-sealed-interfaces island dropped into a Lombok-bean service is a maintenance wound, not an upgrade.
- **Feature-gate by installed version**: no records below 16, no sealed types or pattern-matching `switch` below 21, no virtual threads below 21, no stable structured concurrency below 25, no Spring Boot 4 APIs on a 3.x classpath.
- **Migration is a proposal, never a side effect** (`javax`→`jakarta`, Boot 2→3→4, Java 8/11→21/25). Scope it, price it, run it as its own work — never while delivering a feature.

## Language: what to reach for now

| Instead of | Write |
|---|---|
| Mutable DTO class with getters/setters/equals | `record` — one per boundary, not a single class shared by API and DB |
| `instanceof` ladder plus casts | Pattern-matching `switch` over a `sealed interface`; the compiler proves exhaustiveness |
| Returning `null` for "not found" | `Optional<T>` as a return type only — never a field, never a parameter |
| Checked-exception wrapping ceremony | A domain exception hierarchy, mapped once at the boundary |
| Thread pools sized by folklore for blocking I/O | **Virtual threads** (`Executors.newVirtualThreadPerTaskExecutor()`, `spring.threads.virtual.enabled=true`) |
| Hand-rolled `CompletableFuture` fan-out with leaked cancellation | **Structured concurrency** (`StructuredTaskScope`) — children die with the parent |
| String concatenation for SQL or JSON | Text blocks plus bound parameters; never concatenate SQL |
| `var` everywhere, or nowhere | `var` when the right-hand side already names the type; explicit when it does not |

**Virtual thread caveats**: they scale blocking I/O, not CPU work. Do not pool them. Do not pin them — replace `synchronized` blocks that wrap I/O with `ReentrantLock`. Check ThreadLocal-heavy code (MDC, security context propagation) before flipping the switch.

## Application architecture

- **Package by feature, not by layer.** An `order/` package holding `OrderController`, `OrderService`, `OrderRepository` and `Order` beats four top-level layers that force every change to touch four directories.
- **The dependency arrow points inward**: web → application → domain, and the domain depends on nothing framework-shaped. If domain classes import `org.springframework`, the boundary has already leaked.
- **Constructor injection only** — final fields, no `@Autowired` on fields, no setter injection. Dependencies become visible and the class is testable without a container.
- **Controllers stay thin**: validate, map, delegate, map back. No business rules, no repository calls, no transaction boundaries in the controller.
- **A DTO per boundary.** Never return a JPA entity from an HTTP endpoint — it leaks the schema, triggers lazy loads outside the transaction, and freezes your database shape into your public contract.
- **Configuration** through validated `@ConfigurationProperties` records, not `@Value` scattered across classes. Profiles per environment; secrets from the environment, never committed in `application.yml`.

## Spring Boot in practice

- **Transactions**: `@Transactional` on the application service — never the controller, never the repository. Remember that self-invocation bypasses the proxy, `readOnly = true` on read paths is free performance, and a transaction must never span a remote call.
- **Persistence**: keep the session boundary inside the service. `LazyInitializationException` is a design signal, not a config problem — set `spring.jpa.open-in-view: false` and fix what breaks. For query shape and N+1 discipline load **query-tuning**; for schema and relationships load **db-schema-craft**.
- **Validation**: `@Valid` with Jakarta Bean Validation on request records, and one `@RestControllerAdvice` mapping exceptions to RFC 9457 `ProblemDetail`. One error shape for the entire API.
- **HTTP clients**: declarative HTTP interfaces (`@HttpExchange`) or `RestClient`; `RestTemplate` is legacy. Always set connect and read timeouts — "wait forever" is how one slow dependency takes down the whole service.
- **Async and scheduling**: `@Async` needs its own executor and an uncaught-exception handler, or failures disappear silently.

## Build tooling: the commands that matter

Always use the wrapper (`./mvnw`, `./gradlew`) — it pins the build tool version for everyone on the team.

| Goal | Maven | Gradle |
|---|---|---|
| Fast compile check | `./mvnw -q -o compile` | `./gradlew compileJava` |
| Run one test | `./mvnw test -Dtest=OrderServiceTest#rejects` | `./gradlew test --tests "*OrderServiceTest.rejects"` |
| Package without tests | `./mvnw package -DskipTests` | `./gradlew assemble` |
| Why is this jar on my classpath | `./mvnw dependency:tree -Dincludes=<group>` | `./gradlew dependencyInsight --dependency <name>` |
| Effective config after inheritance | `./mvnw help:effective-pom` | `./gradlew properties` |
| Run with a profile | `./mvnw spring-boot:run -Dspring-boot.run.profiles=dev` | `./gradlew bootRun --args="--spring.profiles.active=dev"` |
| Faster local loop | `-o` offline, `-T 1C` parallel | build cache plus configuration cache |

Pin versions in one place — `dependencyManagement` or a Gradle version catalog. A transitive version bump nobody chose is a future incident.

## Fast feedback

- **Test slices over full context**: `@WebMvcTest` for controllers, `@DataJpaTest` for repositories, plain JUnit for domain logic. `@SpringBootTest` is the slowest tool in the box — reserve it for the few genuine end-to-end paths.
- **Testcontainers for anything touching a real database.** H2 pretending to be PostgreSQL passes tests that production fails; enable container reuse to keep the loop fast.
- **Assert behavior, not implementation.** AssertJ for readable assertions, `@ParameterizedTest` instead of copy-pasted cases, no mocking of value objects or of the framework itself.
- Add `spring-boot-devtools` for restart-on-change locally and keep an uncommitted `application-local.yml`.

## Diagnosing slow or wrong

1. **Reproduce with a measurement**, not a hunch — a Micrometer timer, `@Observed`, or an actuator `/metrics` reading taken before you change anything.
2. **Actuator first**: `/actuator/health`, `/metrics`, `/env`, `/threaddump`, `/heapdump` reveal more in a minute than an afternoon of reading code.
3. **Database before code.** Most "slow Java" is one N+1 or one missing index. Turn on SQL logging plus Hibernate statistics, count the queries per request, then load **query-tuning**.
4. **Then the JVM**: `jcmd <pid> Thread.print` for stuck threads, JFR (`-XX:StartFlightRecording`) for a real profile, async-profiler for flame graphs, GC logs before touching any heap flag.
5. **Never tune from folklore** — no `-Xmx` cargo cult, no thread-pool numbers without a measurement to justify them.

## Rules

1. Detect the installed Java and Spring versions before writing a line; never emit code the classpath cannot run.
2. Constructor injection with final fields. No field injection, no exceptions.
3. Entities never cross the HTTP boundary; use a record DTO per boundary.
4. `@Transactional` belongs on the application service, and no remote call happens inside a transaction.
5. Every outbound HTTP call carries explicit connect and read timeouts.
6. No SQL built by string concatenation — parameters bind, always.
7. Exceptions map to one consistent `ProblemDetail` shape in one advice class.
8. Tests use slices and Testcontainers; a full `@SpringBootTest` needs a stated reason.
9. Never swallow an exception — log it with context or rethrow it. An empty catch block is a bug in hiding.
10. Modernization and migration are separate, proposed, approved work — never a side effect of a feature.

