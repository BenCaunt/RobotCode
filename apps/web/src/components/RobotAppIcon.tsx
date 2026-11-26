import appIconUrl from "../../../../assets/prod/t3-black-web-apple-touch-180.png";

export function RobotAppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
