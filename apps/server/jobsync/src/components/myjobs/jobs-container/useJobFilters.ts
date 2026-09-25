"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Company, JobLocation, JobSource, JobTitle } from "@/models/job.model";

// Owns the URL-synced job list filters (company/title/location/source/applied),
// their display labels, and the clear handlers.
export function useJobFilters({
  companies,
  titles,
  locations,
  sources,
}: {
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryParams = useSearchParams();
  const [companyFilter, setCompanyFilter] = useState<string | null>(
    queryParams.get("company"),
  );
  const [titleFilter, setTitleFilter] = useState<string | null>(
    queryParams.get("title"),
  );
  const [locationFilter, setLocationFilter] = useState<string | null>(
    queryParams.get("location"),
  );
  const [sourceFilter, setSourceFilter] = useState<string | null>(
    queryParams.get("source"),
  );
  const [appliedFilter, setAppliedFilter] = useState(
    queryParams.get("applied") === "true",
  );

  const companyLabel = companyFilter
    ? companies.find((c) => c.value === companyFilter)?.label
    : null;

  const titleLabel = titleFilter
    ? titles.find((t) => t.value === titleFilter)?.label
    : null;

  const locationLabel = locationFilter
    ? locations.find((l) => l.value === locationFilter)?.label
    : null;

  const sourceLabel = sourceFilter
    ? sources.find((s) => s.value === sourceFilter)?.label
    : null;

  const clearCompanyFilter = () => {
    setCompanyFilter(null);
    setAppliedFilter(false);
    router.push(pathname);
  };

  const clearTitleFilter = () => {
    setTitleFilter(null);
    setAppliedFilter(false);
    router.push(pathname);
  };

  const clearLocationFilter = () => {
    setLocationFilter(null);
    setAppliedFilter(false);
    router.push(pathname);
  };

  const clearSourceFilter = () => {
    setSourceFilter(null);
    setAppliedFilter(false);
    router.push(pathname);
  };

  useEffect(() => {
    const cp = queryParams.get("company");
    const tp = queryParams.get("title");
    const lp = queryParams.get("location");
    const sp = queryParams.get("source");
    const ap = queryParams.get("applied") === "true";
    setCompanyFilter(cp);
    setTitleFilter(tp);
    setLocationFilter(lp);
    setSourceFilter(sp);
    setAppliedFilter(ap);
  }, [queryParams]);

  return {
    queryParams,
    companyFilter,
    titleFilter,
    locationFilter,
    sourceFilter,
    appliedFilter,
    companyLabel,
    titleLabel,
    locationLabel,
    sourceLabel,
    clearCompanyFilter,
    clearTitleFilter,
    clearLocationFilter,
    clearSourceFilter,
  };
}
