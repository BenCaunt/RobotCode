import type { SVGProps } from "react";

export function RobotMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="2 1 27 25" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M18 10L23 2H27L22 10ZM5 9H25Q28 9 28 12V22L25 25H6Q3 25 3 22V12Q3 10 5 9ZM8 14V20H13V14ZM18 14V20H23V14Z"
        fillRule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}
