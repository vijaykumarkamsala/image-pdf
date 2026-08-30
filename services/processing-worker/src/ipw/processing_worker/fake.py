"""Deterministic fake processor used by the Recovery 1 worker boundary."""

from __future__ import annotations

from ipw.contracts.product import ProcessingJob, ProcessorFacts, ProvenanceRecord
from ipw.processing_worker.worker import fake_processor_facts


class DeterministicFakeProcessor:
    """Processor adapter that records provenance without changing customer data."""

    @property
    def facts(self) -> ProcessorFacts:
        return fake_processor_facts()

    def process(self, job: ProcessingJob) -> ProvenanceRecord:
        return ProvenanceRecord(
            provenance_id=f"{job.job_id}-provenance",
            input_refs=job.source_refs,
            recipe_name="deterministic-fake",
            processor_id=self.facts.processor_id,
            processor_version=self.facts.version,
        )
