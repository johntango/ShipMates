# Durable supervisor

`DurableSupervisor` owns the non-conversational control loop: observe live
processes and external systems, ask the central engine for reconciliation
decisions, advance eligible work through typed commands, and derive a fresh
projection. Startup runs this sequence before scheduling begins. Overlapping
runs share one promise, and shutdown cancels scheduling and awaits in-flight
work.

Firstmate, Herdr, and dashboard connections are projection clients. Connecting
immediately receives current state; disconnecting removes only the client and
does not stop reconciliation, workers, advancement, or monitoring. Client send
failures are contained and cannot fail the supervisor run.

`createSupervisorTask` supplies the scheduler callback so the serialized
watchdog scheduler invokes the same durable service used at startup and by
commands. The interactive shell can be migrated to construct this service
without changing the service contract or treating its pane as lifecycle state.
